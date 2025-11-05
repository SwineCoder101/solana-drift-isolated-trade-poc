use std::time::Duration;

use axum::{
	extract::{Path, Query, State},
	http::StatusCode,
	response::{IntoResponse, Response},
	routing::{get, post},
	Json, Router,
};
use serde_json::{json, Value};
use tracing::info;

use crate::{
	ipc::{IpcError, TsIpc},
	types::{
		ApiErrorBody, ClosePositionRequest, MarketQuery, OpenIsolatedRequest,
		TransferMarginRequest, WalletQuery,
	},
};

#[derive(Clone)]
pub struct AppState {
	pub ipc: TsIpc,
}

pub fn router(state: AppState) -> Router {
	Router::new()
		.route("/positions", get(get_positions))
		.route("/trade-history", get(get_trades))
		.route("/markets/:symbol", get(get_market))
		.route("/orders/open-isolated", post(open_isolated))
		.route("/orders/close", post(close_position))
		.route("/margin/transfer", post(transfer_margin))
		.with_state(state)
}

struct ApiError {
	status: StatusCode,
	message: String,
}

impl ApiError {
	fn new(status: StatusCode, message: impl Into<String>) -> Self {
		Self {
			status,
			message: message.into(),
		}
	}
}

impl IntoResponse for ApiError {
	fn into_response(self) -> Response {
		let body = Json(ApiErrorBody {
			error: &self.message,
		});
		(self.status, body).into_response()
	}
}

fn map_ipc_error(err: IpcError) -> ApiError {
	match err {
		IpcError::Timeout => ApiError::new(StatusCode::GATEWAY_TIMEOUT, "worker timeout"),
		IpcError::WorkerCrashed | IpcError::Spawn(_) | IpcError::Write(_) => {
			ApiError::new(StatusCode::BAD_GATEWAY, "worker unavailable")
		}
		IpcError::Protocol(message) => ApiError::new(StatusCode::BAD_REQUEST, message),
		IpcError::Remote(message) => ApiError::new(StatusCode::BAD_REQUEST, message),
	}
}

fn validate_wallet(wallet: &str) -> Result<(), ApiError> {
	if wallet.len() < 32 {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"wallet must be a valid public key",
		));
	}
	Ok(())
}

fn ensure_positive(name: &str, value: f64) -> Result<(), ApiError> {
	if !value.is_finite() || value <= 0.0 {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			format!("{name} must be positive"),
		));
	}
	Ok(())
}

async fn open_isolated(
	State(state): State<AppState>,
	Json(body): Json<OpenIsolatedRequest>,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&body.wallet)?;
	ensure_positive("margin", body.margin)?;
	if !body.size.is_finite() || body.size == 0.0 {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"size must be a non-zero number",
		));
	}
	if !body.leverage.is_finite() || body.leverage <= 0.0 || body.leverage > 100.0 {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"leverage must be between 0 and 100",
		));
	}

	let args = json!({
		"wallet": body.wallet,
		"market": body.market,
		"size": body.size,
		"leverage": body.leverage,
		"margin": body.margin,
	});
	info!("open isolated request -> {}", body.market);
	state
		.ipc
		.call("openIsolated", args, Duration::from_secs(10))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn close_position(
	State(state): State<AppState>,
	Json(body): Json<ClosePositionRequest>,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&body.wallet)?;
	if let Some(size) = body.size {
		if !size.is_finite() || size <= 0.0 {
			return Err(ApiError::new(
				StatusCode::BAD_REQUEST,
				"size must be positive when provided",
			));
		}
	}

	let args = json!({
		"wallet": body.wallet,
		"market": body.market,
		"size": body.size,
	});

	state
		.ipc
		.call("closePosition", args, Duration::from_secs(10))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn transfer_margin(
	State(state): State<AppState>,
	Json(body): Json<TransferMarginRequest>,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&body.wallet)?;
	if !body.delta.is_finite() || body.delta == 0.0 {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"delta must be a non-zero number",
		));
	}

	let args = json!({
		"wallet": body.wallet,
		"market": body.market,
		"delta": body.delta,
	});

	state
		.ipc
		.call("transferMargin", args, Duration::from_secs(10))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn get_positions(
	State(state): State<AppState>,
	Query(query): Query<WalletQuery>,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
	let args = json!({ "wallet": query.wallet });
	state
		.ipc
		.call("getPositions", args, Duration::from_secs(5))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn get_trades(
	State(state): State<AppState>,
	Query(query): Query<WalletQuery>,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
	let args = json!({ "wallet": query.wallet });
	state
		.ipc
		.call("getTrades", args, Duration::from_secs(5))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn get_market(
	State(state): State<AppState>,
	Path(symbol): Path<String>,
) -> Result<Json<Value>, ApiError> {
	let args = json!({ "symbol": symbol });
	state
		.ipc
		.call("getMarket", args, Duration::from_secs(5))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}
