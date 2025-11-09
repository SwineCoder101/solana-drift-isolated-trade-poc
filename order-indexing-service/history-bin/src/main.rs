use std::{env, net::SocketAddr};

use anyhow::{Context, Result};
use axum::{extract::Query, routing::get, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::signal;
use tracing::info;

#[derive(Serialize)]
struct HistoryEntry {
    signature: String,
    action: String,
    amount: f64,
    asset_symbol: String,
    asset_mint: String,
    slot: i64,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    block_time: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct HistoryQuery {
    wallet: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
struct HistoryResponse {
    entries: Vec<HistoryEntry>,
}

#[derive(Clone)]
struct ApiState {
    pool: PgPool,
    default_wallet: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    dotenvy::dotenv().ok();

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&env::var("DATABASE_URL").context("DATABASE_URL missing")?)
        .await?;

    let state = ApiState {
        pool: pool.clone(),
        default_wallet: env::var("ADMIN_WALLET").ok(),
    };

    let app = Router::new()
        .route("/history", get(history_handler))
        .with_state(state);

    let addr: SocketAddr = (
        [0, 0, 0, 0],
        env::var("HISTORY_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(4010),
    )
        .into();
    info!("history service listening", %addr);

    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn history_handler(
    Query(params): Query<HistoryQuery>,
    axum::extract::State(state): axum::extract::State<ApiState>,
) -> Result<Json<HistoryResponse>, axum::http::StatusCode> {
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    let offset = params.offset.unwrap_or(0).max(0);
    let wallet_filter = params.wallet.or_else(|| state.default_wallet.clone());

    let rows = if let Some(wallet) = wallet_filter {
        sqlx::query_as!(
            HistoryEntry,
            r#"SELECT signature, action, amount, asset_symbol, asset_mint, slot, block_time as "block_time?" 
               FROM trade_history WHERE wallet = $1 
               ORDER BY slot DESC LIMIT $2 OFFSET $3"#,
            wallet,
            limit,
            offset
        )
        .fetch_all(&state.pool)
        .await
    } else {
        sqlx::query_as!(
            HistoryEntry,
            r#"SELECT signature, action, amount, asset_symbol, asset_mint, slot, block_time as "block_time?"
               FROM trade_history ORDER BY slot DESC LIMIT $1 OFFSET $2"#,
            limit,
            offset
        )
        .fetch_all(&state.pool)
        .await
    }
    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(HistoryResponse { entries: rows }))
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
