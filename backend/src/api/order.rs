use axum::{Json, Router, response::IntoResponse, routing::post};
use serde::{Deserialize, Serialize};
use tracing::{info, instrument};

pub fn routes() -> Router {
    Router::new().route("/perp", post(create_perp_order))
}

#[instrument(skip_all)]
async fn create_perp_order(Json(payload): Json<PerpOrderRequest>) -> impl IntoResponse {
    let response = process_perp_order(payload).await;
    Json(response)
}

#[instrument(skip_all)]
pub async fn process_perp_order(payload: PerpOrderRequest) -> OrderAccepted {
    info!(
        wallet = %payload.wallet,
        asset = %payload.asset,
        side = ?payload.side,
        leverage = payload.leverage,
        initial_amount = payload.initial_amount,
        "received perpetual order request"
    );

    OrderAccepted {
        status: "accepted".to_string(),
        echo: payload,
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PerpOrderRequest {
    wallet: String,
    asset: String,
    side: OrderSide,
    leverage: f32,
    #[serde(rename = "initialAmount")]
    initial_amount: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderSide {
    Long,
    Short,
}

#[derive(Debug, Serialize)]
pub struct OrderAccepted {
    pub status: String,
    pub echo: PerpOrderRequest,
}
