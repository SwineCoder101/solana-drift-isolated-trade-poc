use std::{collections::HashSet, env, str::FromStr, sync::Arc};

use anyhow::{anyhow, Context, Result};
use indexer_common::{connect_pool, insert_trade, parse_pubkey, parse_trade_from_tx, ui_encoding};
use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_config::{CommitmentConfig, GetConfirmedSignaturesForAddress2Config, RpcTransactionConfig},
    rpc_response::RpcConfirmedTransactionStatusWithSignature,
};
use solana_program::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_transaction_status::EncodedTransactionWithStatusMeta;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    dotenvy::dotenv().ok();

    let rpc_url = env::var("RPC_URL").context("RPC_URL not set")?;
    let wallet_key = parse_pubkey(&env::var("ADMIN_WALLET").context("ADMIN_WALLET not set")?, "wallet")?;
    let drift_program =
        parse_pubkey(&env::var("DRIFT_PROGRAM_ID").context("DRIFT_PROGRAM_ID not set")?, "program")?;
    let drift_account =
        parse_pubkey(&env::var("DRIFT_ACCOUNT_ID").context("DRIFT_ACCOUNT_ID not set")?, "drift account")?;
    let db_url = env::var("DATABASE_URL").context("DATABASE_URL not set")?;

    let rpc = Arc::new(RpcClient::new_with_commitment(
        rpc_url.clone(),
        CommitmentConfig::confirmed(),
    ));
    let pool = connect_pool(&db_url).await?;

    let fetch_limit: usize = env::var("BACKFILL_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);

    info!(
        %rpc_url,
        wallet = %wallet_key,
        "starting backfill run",
    );

    let mut signatures = HashSet::new();
    collect_signatures(&rpc, &wallet_key, fetch_limit, &mut signatures).await?;
    collect_signatures(&rpc, &drift_account, fetch_limit, &mut signatures).await?;

    let mut inserted = 0usize;
    for sig_str in signatures {
        let signature = Signature::from_str(&sig_str)
            .map_err(|err| anyhow!("invalid signature {sig_str}: {err}"))?;
        match fetch_transaction(&rpc, signature).await {
            Ok(tx) => {
                if let Some(record) = parse_trade_from_tx(&tx, &wallet_key, &drift_program, &drift_account) {
                    if let Err(err) = insert_trade(&pool, &record).await {
                        error!(%record.signature, ?err, "failed to insert trade");
                    } else {
                        inserted += 1;
                    }
                }
            }
            Err(err) => warn!(?err, %sig_str, "failed to fetch transaction"),
        }
    }

    info!(?inserted, "backfill completed");
    Ok(())
}

async fn collect_signatures(
    rpc: &Arc<RpcClient>,
    address: &Pubkey,
    max: usize,
    acc: &mut HashSet<String>,
) -> Result<()> {
    let mut before: Option<String> = None;
    loop {
        let already = acc.len();
        if already >= max {
            break;
        }
        let remaining = max - already;
        let limit = remaining.min(1000);
        let config = GetConfirmedSignaturesForAddress2Config {
            before: before.clone(),
            until: None,
            limit: Some(limit),
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        };
        let chunk: Vec<RpcConfirmedTransactionStatusWithSignature> =
            rpc.get_signatures_for_address_with_config(address, config).await?;
        if chunk.is_empty() {
            break;
        }
        before = chunk.last().map(|entry| entry.signature.clone());
        for entry in chunk {
            acc.insert(entry.signature);
        }
    }

    Ok(())
}

async fn fetch_transaction(
    rpc: &Arc<RpcClient>,
    signature: Signature,
) -> Result<EncodedTransactionWithStatusMeta> {
    let config = RpcTransactionConfig {
        encoding: Some(ui_encoding()),
        commitment: Some(CommitmentConfig::confirmed()),
        max_supported_transaction_version: Some(0),
    };
    let tx = rpc
        .get_transaction_with_config(&signature, config)
        .await
        .context("rpc get_transaction failed")?;
    Ok(tx)
}
