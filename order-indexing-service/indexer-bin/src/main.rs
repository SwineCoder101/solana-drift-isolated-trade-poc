use std::{
    env,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{Context, Result};
use axum::{routing::get, Json, Router};
use indexer_common::{connect_pool, insert_trade, parse_pubkey, parse_trade_from_tx, ui_encoding};
use serde::Serialize;
use solana_client::{
    nonblocking::{pubsub_client::PubsubClient, rpc_client::RpcClient},
    rpc_config::{
        CommitmentConfig, RpcTransactionConfig, RpcTransactionLogsConfig, RpcTransactionLogsFilter,
    },
};
use solana_program::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_transaction_status::EncodedTransactionWithStatusMeta;
use sqlx::PgPool;
use tokio::{signal, sync::RwLock, time::sleep};
use tracing::{error, info, warn};

#[derive(Clone, Default)]
struct StreamStats {
    last_signature: Arc<RwLock<Option<String>>>,
    last_slot: Arc<AtomicU64>,
}

#[derive(Clone)]
struct AppState {
    stats: StreamStats,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    last_slot: u64,
    last_signature: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    dotenvy::dotenv().ok();

    let rpc_http = env::var("RPC_URL").context("RPC_URL missing")?;
    let rpc_ws = env::var("RPC_WS_URL").unwrap_or_else(|_| infer_ws(&rpc_http));
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL missing")?;
    let wallet = parse_pubkey(&env::var("ADMIN_WALLET").context("ADMIN_WALLET missing")?, "wallet")?;
    let drift_program =
        parse_pubkey(&env::var("DRIFT_PROGRAM_ID").context("DRIFT_PROGRAM_ID missing")?, "program")?;
    let drift_account =
        parse_pubkey(&env::var("DRIFT_ACCOUNT_ID").context("DRIFT_ACCOUNT_ID missing")?, "drift account")?;

    let pool = connect_pool(&database_url).await?;
    let stats = StreamStats::default();
    let app_state = AppState { stats: stats.clone() };

    let rpc_client = Arc::new(RpcClient::new_with_commitment(
        rpc_http.clone(),
        CommitmentConfig::confirmed(),
    ));

    let streamer = tokio::spawn(run_streamer(
        rpc_client.clone(),
        pool.clone(),
        stats.clone(),
        rpc_ws.clone(),
        wallet,
        drift_program,
        drift_account,
    ));

    let app = Router::new().route("/health", get(health)).with_state(app_state);

    let port: u16 = env::var("INDEXER_HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4000);
    let addr = ([0, 0, 0, 0], port).into();
    info!("indexer listening on {addr}, streaming via {rpc_ws}");

    let server = axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .with_graceful_shutdown(shutdown_signal());

    tokio::select! {
        result = streamer => {
            if let Err(err) = result {
                error!(?err, "streamer task failed");
            }
        },
        result = server => {
            result?;
        }
    }

    Ok(())
}

async fn run_streamer(
    rpc: Arc<RpcClient>,
    pool: PgPool,
    stats: StreamStats,
    ws_url: String,
    wallet: Pubkey,
    drift_program: Pubkey,
    drift_account: Pubkey,
) {
    loop {
        let filter = RpcTransactionLogsFilter::Mentions(vec![drift_program.to_string()]);
        let config = RpcTransactionLogsConfig {
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        };

        match PubsubClient::logs_subscribe(&ws_url, filter, config).await {
            Ok((mut _client, mut receiver)) => {
                info!("log stream connected");
                while let Some(message) = receiver.recv().await {
                    match message {
                        Ok(log) => {
                            stats
                                .last_slot
                                .store(log.context.slot, Ordering::Relaxed);
                            let signature = log.value.signature.clone();
                            {
                                let mut guard = stats.last_signature.write().await;
                                *guard = Some(signature.clone());
                            }
                            if let Err(err) = handle_signature(
                                &rpc,
                                &pool,
                                &signature,
                                wallet,
                                drift_program,
                                drift_account,
                            )
                            .await
                            {
                                warn!(?err, %signature, "failed to index signature");
                            }
                        }
                        Err(err) => warn!(?err, "log stream error"),
                    }
                }
                warn!("log stream ended, reconnecting...");
            }
            Err(err) => {
                warn!(?err, "failed to connect to log stream");
            }
        }
        sleep(Duration::from_secs(5)).await;
    }
}

async fn handle_signature(
    rpc: &Arc<RpcClient>,
    pool: &PgPool,
    signature_str: &str,
    wallet: Pubkey,
    drift_program: Pubkey,
    drift_account: Pubkey,
) -> Result<()> {
    let signature = Signature::from_str(signature_str)?;
    let config = RpcTransactionConfig {
        encoding: Some(ui_encoding()),
        commitment: Some(CommitmentConfig::confirmed()),
        max_supported_transaction_version: Some(0),
    };
    let tx: EncodedTransactionWithStatusMeta = rpc
        .get_transaction_with_config(&signature, config)
        .await?;

    if let Some(record) = parse_trade_from_tx(&tx, &wallet, &drift_program, &drift_account) {
        insert_trade(pool, &record).await?;
    }

    Ok(())
}

async fn health(axum::extract::State(state): axum::extract::State<AppState>) -> Json<HealthResponse> {
    let last_signature = state.stats.last_signature.read().await.clone();
    Json(HealthResponse {
        status: "ok",
        last_slot: state.stats.last_slot.load(Ordering::Relaxed),
        last_signature,
    })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

fn infer_ws(rpc_http: &str) -> String {
    if rpc_http.starts_with("https://") {
        rpc_http.replacen("https://", "wss://", 1)
    } else if rpc_http.starts_with("http://") {
        rpc_http.replacen("http://", "ws://", 1)
    } else if rpc_http.starts_with("wss://") || rpc_http.starts_with("ws://") {
        rpc_http.to_string()
    } else {
        format!("wss://{rpc_http}")
    }
}
