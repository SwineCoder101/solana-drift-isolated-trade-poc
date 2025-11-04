use std::net::SocketAddr;

use axum::{
    Json, Router,
    http::Method,
    response::IntoResponse,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, instrument};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_origin(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/orders/perp", post(create_perp_order))
        .layer(cors);

    let addr: SocketAddr = "0.0.0.0:4000".parse()?;
    info!("backend listening on {addr}");

    axum::serve(tokio::net::TcpListener::bind(addr).await?, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

#[instrument(skip_all)]
async fn create_perp_order(Json(payload): Json<PerpOrderRequest>) -> impl IntoResponse {
    info!(
        wallet = %payload.wallet,
        asset = %payload.asset,
        side = ?payload.side,
        leverage = payload.leverage,
        initial_amount = payload.initial_amount,
        "received perpetual order request"
    );

    let response = OrderAccepted {
        status: "accepted".to_string(),
        echo: payload,
    };

    Json(response)
}

async fn health() -> impl IntoResponse {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
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

#[derive(Debug, Deserialize, Serialize)]
struct PerpOrderRequest {
    wallet: String,
    asset: String,
    side: OrderSide,
    leverage: f32,
    #[serde(rename = "initialAmount")]
    initial_amount: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum OrderSide {
    Long,
    Short,
}

#[derive(Debug, Serialize)]
struct OrderAccepted {
    status: String,
    echo: PerpOrderRequest,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
}
