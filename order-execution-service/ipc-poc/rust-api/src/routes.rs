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
		ApiErrorBody, ClosePositionRequest, DepositNativeRequest, DepositTokenRequest, IsolatedBalanceQuery,
		OpenIsolatedRequest, TransferMarginRequest, WalletQuery,
	},
	executor::ExecutorError,
};

#[derive(Clone)]
pub struct AppState {
	pub ipc: TsIpc,
	pub executor: std::sync::Arc<crate::executor::TxExecutor>,
}

pub fn router(state: AppState) -> Router {
	Router::new()
		.route("/positions", get(get_positions))
		.route("/positions/details", get(get_position_details))
		.route("/trade-history", get(get_trades))
		.route("/markets/:symbol", get(get_market))
		.route(
			"/positions/isolated-balance",
			get(get_isolated_balance),
		)
		.route("/server/public-key", get(get_server_public_key))
		.route("/orders/open-isolated", post(open_isolated))
		.route(
			"/orders/open-isolated/execute",
			post(open_isolated_execute),
		)
		.route("/orders/close", post(close_position))
		.route("/orders/close/execute", post(close_position_execute))
		.route("/margin/transfer", post(transfer_margin))
		.route(
			"/margin/transfer/execute",
			post(transfer_margin_execute),
		)
		.route("/margin/deposit-native", post(deposit_native))
		.route(
			"/margin/deposit-native/execute",
			post(deposit_native_execute),
		)
		.route("/margin/deposit-token", post(deposit_token))
		.route(
			"/margin/deposit-token/execute",
			post(deposit_token_execute),
		)
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

const WORKER_TIMEOUT: Duration = Duration::from_secs(10);

async fn open_isolated(
	State(state): State<AppState>,
	Json(body): Json<OpenIsolatedRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = open_isolated_build(&state, &body).await?;
	Ok(Json(value))
}

async fn open_isolated_execute(
	State(state): State<AppState>,
	Json(body): Json<OpenIsolatedRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = open_isolated_build(&state, &body).await?;
	let executed = execute_transaction(&state, value).await?;
	Ok(Json(executed))
}

async fn close_position(
	State(state): State<AppState>,
	Json(body): Json<ClosePositionRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = close_position_build(&state, &body).await?;
	Ok(Json(value))
}

async fn close_position_execute(
	State(state): State<AppState>,
	Json(body): Json<ClosePositionRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = close_position_build(&state, &body).await?;
	let executed = execute_transaction(&state, value).await?;
	Ok(Json(executed))
}

async fn transfer_margin(
	State(state): State<AppState>,
	Json(body): Json<TransferMarginRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = transfer_margin_build(&state, &body).await?;
	Ok(Json(value))
}

async fn transfer_margin_execute(
	State(state): State<AppState>,
	Json(body): Json<TransferMarginRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = transfer_margin_build(&state, &body).await?;
	let executed = execute_transaction(&state, value).await?;
	Ok(Json(executed))
}

async fn deposit_native(
	State(state): State<AppState>,
	Json(body): Json<DepositNativeRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = deposit_native_build(&state, &body).await?;
	Ok(Json(value))
}

async fn deposit_native_execute(
	State(state): State<AppState>,
	Json(body): Json<DepositNativeRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = deposit_native_build(&state, &body).await?;
	let executed = execute_transaction(&state, value).await?;
	Ok(Json(executed))
}

async fn deposit_token(
	State(state): State<AppState>,
	Json(body): Json<DepositTokenRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = deposit_token_build(&state, &body).await?;
	Ok(Json(value))
}

async fn deposit_token_execute(
	State(state): State<AppState>,
	Json(body): Json<DepositTokenRequest>,
) -> Result<Json<Value>, ApiError> {
	let value = deposit_token_build(&state, &body).await?;
	let executed = execute_transaction(&state, value).await?;
	Ok(Json(executed))
}

async fn open_isolated_build(
	state: &AppState,
	body: &OpenIsolatedRequest,
) -> Result<Value, ApiError> {
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
	call_worker(state, "openIsolated", args, WORKER_TIMEOUT).await
}

async fn close_position_build(
	state: &AppState,
	body: &ClosePositionRequest,
) -> Result<Value, ApiError> {
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
	call_worker(state, "closePosition", args, WORKER_TIMEOUT).await
}

async fn transfer_margin_build(
	state: &AppState,
	body: &TransferMarginRequest,
) -> Result<Value, ApiError> {
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
	call_worker(state, "transferMargin", args, WORKER_TIMEOUT).await
}

async fn deposit_native_build(
	state: &AppState,
	body: &DepositNativeRequest,
) -> Result<Value, ApiError> {
	validate_wallet(&body.wallet)?;
	if !body.amount.is_finite() || body.amount <= 0.0 {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"amount must be positive",
		));
	}
	let args = json!({
		"wallet": body.wallet,
		"amount": body.amount,
		"market": body.market,
	});
	call_worker(state, "depositNativeSol", args, WORKER_TIMEOUT).await
}

async fn deposit_token_build(
	state: &AppState,
	body: &DepositTokenRequest,
) -> Result<Value, ApiError> {
	validate_wallet(&body.wallet)?;
	if !body.amount.is_finite() || body.amount <= 0.0 {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"amount must be positive",
		));
	}
	let args = json!({
		"wallet": body.wallet,
		"amount": body.amount,
		"market": body.market,
	});
	call_worker(state, "depositToken", args, WORKER_TIMEOUT).await
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

async fn get_position_details(
	State(state): State<AppState>,
	Query(query): Query<WalletQuery>,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
	let args = json!({ "wallet": query.wallet });
	state
		.ipc
		.call("getPositionDetails", args, Duration::from_secs(5))
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

async fn get_isolated_balance(
	State(state): State<AppState>,
	Query(query): Query<IsolatedBalanceQuery>,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
	let args = json!({
		"wallet": query.wallet,
		"market": query.market,
	});
	state
		.ipc
		.call("getIsolatedBalance", args, Duration::from_secs(5))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn get_server_public_key(
	State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
	let args = json!({});
	state
		.ipc
		.call("getServerPublicKey", args, Duration::from_secs(5))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn call_worker(
	state: &AppState,
	function: &str,
	args: Value,
	timeout: Duration,
) -> Result<Value, ApiError> {
	state
		.ipc
		.call(function, args, timeout)
		.await
		.map_err(map_ipc_error)
}

async fn execute_transaction(state: &AppState, mut value: Value) -> Result<Value, ApiError> {
	let tx_base64 = value
		.get("txBase64")
		.and_then(|v| v.as_str())
		.ok_or_else(|| {
			ApiError::new(
				StatusCode::INTERNAL_SERVER_ERROR,
				"worker response missing txBase64",
			)
		})?;
	let signature = state
		.executor
		.execute(tx_base64)
		.await
		.map_err(map_executor_error)?;
	if let Some(obj) = value.as_object_mut() {
		obj.insert("txSignature".into(), json!(signature.to_string()));
	}
	Ok(value)
}

fn map_executor_error(err: ExecutorError) -> ApiError {
	match err {
		ExecutorError::MissingKey => {
			ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "server missing signing key")
		}
		ExecutorError::InvalidKey(msg) => {
			ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("invalid signing key: {msg}"))
		}
		ExecutorError::Decode(msg) => {
			ApiError::new(StatusCode::BAD_REQUEST, format!("invalid transaction: {msg}"))
		}
		ExecutorError::Rpc(msg) => ApiError::new(StatusCode::BAD_GATEWAY, msg),
	}
}
