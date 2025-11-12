use std::{fs, path::Path, sync::Arc};

use anyhow::{Context, Result};
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::{types::ToSql, Client, Config};

use crate::decoder::ActionRecord;

pub async fn connect(database_url: &str) -> Result<(Arc<Client>, tokio::task::JoinHandle<()>)> {
    let config: Config = database_url.parse().context("invalid DATABASE_URL")?;

    let mut builder = TlsConnector::builder();
    if accept_invalid_certs() {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    let connector = builder.build().context("failed to build TLS connector")?;
    let tls = MakeTlsConnector::new(connector);
    let (client, connection) = config
        .connect(tls)
        .await
        .context("connecting to postgres failed")?;
    let handle = tokio::spawn(async move {
        if let Err(err) = connection.await {
            tracing::error!(?err, "postgres connection error");
        }
    });
    Ok((Arc::new(client), handle))
}

fn accept_invalid_certs() -> bool {
    match std::env::var("PG_ACCEPT_INVALID_CERTS") {
        Ok(value) => matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"),
        Err(_) => false,
    }
}

pub async fn run_migrations(client: &Client) -> Result<()> {
    let dir = Path::new("migrations");
    if !dir.exists() {
        return Ok(());
    }

    let mut entries = fs::read_dir(dir)
        .context("failed to read migrations directory")?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("sql") {
            continue;
        }
        let sql = fs::read_to_string(&path)
            .with_context(|| format!("failed to read migration {}", path.display()))?;
        client
            .batch_execute(&sql)
            .await
            .with_context(|| format!("failed to run migration {}", path.display()))?;
    }

    Ok(())
}

pub async fn insert_actions(client: &Client, actions: &[ActionRecord]) -> Result<u64> {
    if actions.is_empty() {
        return Ok(0);
    }

    let mut total = 0u64;
    for action in actions {
        let instruction_index = i32::try_from(action.instruction_index)
            .context("instruction index exceeds i32 range")?;
        let slot = i64::try_from(action.slot).context("slot exceeds i64 range")?;
        let base_asset_amount = action
            .base_asset_amount
            .map(|v| i64::try_from(v).context("base asset amount exceeds i64"))
            .transpose()?;
        let price = action
            .price
            .map(|v| i64::try_from(v).context("price exceeds i64"))
            .transpose()?;
        let amount = action
            .amount
            .map(|v| i64::try_from(v).context("amount exceeds i64"))
            .transpose()?;
        let token_amount = action
            .token_amount
            .map(|v| i64::try_from(v).context("token amount exceeds i64"))
            .transpose()?;

        let params: &[&(dyn ToSql + Sync)] = &[
            &action.signature,
            &instruction_index,
            &slot,
            &action.block_time,
            &action.action_type,
            &action.market_index.map(|v| v as i16),
            &action.perp_market_index.map(|v| v as i16),
            &action.spot_market_index.map(|v| v as i16),
            &action.direction.as_deref(),
            &base_asset_amount,
            &price,
            &action.reduce_only,
            &action.leverage,
            &amount,
            &action.token_account.as_deref(),
            &action.token_mint.as_deref(),
            &token_amount,
        ];

        let rows = client
            .execute(
                r#"
INSERT INTO drift_action_logs (
    signature,
    instruction_index,
    slot,
    block_time,
    action_type,
    market_index,
    perp_market_index,
    spot_market_index,
    direction,
    base_asset_amount,
    price,
    reduce_only,
    leverage,
    amount,
    token_account,
    token_mint,
    token_amount
) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
)
ON CONFLICT (signature, instruction_index) DO UPDATE SET
    slot = EXCLUDED.slot,
    block_time = EXCLUDED.block_time,
    action_type = EXCLUDED.action_type,
    market_index = EXCLUDED.market_index,
    perp_market_index = EXCLUDED.perp_market_index,
    spot_market_index = EXCLUDED.spot_market_index,
    direction = EXCLUDED.direction,
    base_asset_amount = EXCLUDED.base_asset_amount,
    price = EXCLUDED.price,
    reduce_only = EXCLUDED.reduce_only,
    leverage = EXCLUDED.leverage,
    amount = EXCLUDED.amount,
    token_account = EXCLUDED.token_account,
    token_mint = EXCLUDED.token_mint,
    token_amount = EXCLUDED.token_amount,
    inserted_at = NOW()
"#,
                params,
            )
            .await
            .context("failed to upsert drift_action_logs")?;
        total += rows;
    }

    Ok(total)
}

pub async fn fetch_actions(client: &Client, limit: i64) -> Result<Vec<ActionRecord>> {
    let rows = client
        .query(
            r#"
SELECT
    signature,
    instruction_index,
    slot,
    block_time,
    action_type,
    market_index,
    perp_market_index,
    spot_market_index,
    direction,
    base_asset_amount,
    price,
    reduce_only,
    leverage,
    amount,
    token_account,
    token_mint,
    token_amount
FROM drift_action_logs
ORDER BY slot DESC
LIMIT $1
"#,
            &[&limit],
        )
        .await
        .context("failed to query drift_action_logs")?;

    rows.into_iter()
        .map(|row| {
            let instruction_index: i32 = row.get("instruction_index");
            let slot: i64 = row.get("slot");
            Ok(ActionRecord {
                signature: row.get("signature"),
                instruction_index: usize::try_from(instruction_index)
                    .context("instruction_index negative")?,
                slot: u64::try_from(slot).context("slot negative")?,
                block_time: row.get("block_time"),
                action_type: row.get("action_type"),
                market_index: row.get::<_, Option<i16>>("market_index").map(|v| v as u16),
                perp_market_index: row
                    .get::<_, Option<i16>>("perp_market_index")
                    .map(|v| v as u16),
                spot_market_index: row
                    .get::<_, Option<i16>>("spot_market_index")
                    .map(|v| v as u16),
                direction: row.get::<_, Option<String>>("direction"),
                base_asset_amount: row
                    .get::<_, Option<i64>>("base_asset_amount")
                    .map(|v| v as u64),
                price: row.get::<_, Option<i64>>("price").map(|v| v as u64),
                reduce_only: row.get("reduce_only"),
                leverage: row.get("leverage"),
                amount: row.get::<_, Option<i64>>("amount").map(|v| v as u64),
                token_account: row.get::<_, Option<String>>("token_account"),
                token_mint: row.get::<_, Option<String>>("token_mint"),
                token_amount: row.get::<_, Option<i64>>("token_amount").map(|v| v as u64),
            })
        })
        .collect()
}
