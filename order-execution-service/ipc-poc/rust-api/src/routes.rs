use std::{sync::Arc, time::Duration};

use axum::{
	extract::{OriginalUri, Path, Query, State},
	http::{StatusCode, Uri},
	response::{IntoResponse, Response},
	routing::{get, post},
	Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use tracing::{debug, error, info, warn};

use crate::{
	decoder::{ActionRecord, DriftDecoder},
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
	pub executor: Arc<crate::executor::TxExecutor>,
	pub db: PgPool,
	pub decoder: Arc<DriftDecoder>,
}

pub fn router(state: AppState) -> Router {
	Router::new()
		.route("/positions", get(get_positions))
		.route("/balances", get(get_balances))
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
		.route("/actions/decode", post(decode_signature_route))
		.with_state(state)
}

#[derive(Debug)]
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

async fn persist_actions(pool: &PgPool, actions: &[ActionRecord]) -> Result<u64, ApiError> {
	if actions.is_empty() {
		return Ok(0);
	}

	let mut tx = pool.begin().await.map_err(map_db_error)?;
	let mut rows = 0u64;
	for action in actions {
		let slot = to_i64("slot", action.slot)?;
		let instruction_index = usize_to_i32("instruction_index", action.instruction_index)?;
		let base_asset_amount = opt_u64_to_i64("base_asset_amount", action.base_asset_amount)?;
		let price = opt_u64_to_i64("price", action.price)?;
		let amount = opt_u64_to_i64("amount", action.amount)?;
		let token_amount = opt_u64_to_i64("token_amount", action.token_amount)?;
		let direction = action.direction.clone();
		let token_account = action.token_account.clone();
		let token_mint = action.token_mint.clone();

		let result = sqlx::query(
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
			)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
		)
		.bind(&action.signature)
		.bind(instruction_index)
		.bind(slot)
		.bind(action.block_time)
		.bind(&action.action_type)
		.bind(action.market_index.map(|v| v as i16))
		.bind(action.perp_market_index.map(|v| v as i16))
		.bind(action.spot_market_index.map(|v| v as i16))
		.bind(direction)
		.bind(base_asset_amount)
		.bind(price)
		.bind(action.reduce_only)
		.bind(action.leverage)
		.bind(amount)
		.bind(token_account)
		.bind(token_mint)
		.bind(token_amount)
		.execute(&mut *tx)
		.await
		.map_err(map_db_error)?;

		rows += result.rows_affected();
	}

	tx.commit().await.map_err(map_db_error)?;
	Ok(rows)
}

fn map_db_error(err: sqlx::Error) -> ApiError {
	error!(?err, "database error");
	ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "database error")
}

fn to_i64(name: &str, value: u64) -> Result<i64, ApiError> {
	i64::try_from(value).map_err(|_| {
		ApiError::new(
			StatusCode::BAD_REQUEST,
			format!("{name} value exceeds i64 range"),
		)
	})
}

fn opt_u64_to_i64(name: &str, value: Option<u64>) -> Result<Option<i64>, ApiError> {
	value
		.map(|v| to_i64(name, v))
		.transpose()
}

fn usize_to_i32(name: &str, value: usize) -> Result<i32, ApiError> {
	i32::try_from(value).map_err(|_| {
		ApiError::new(
			StatusCode::BAD_REQUEST,
			format!("{name} value exceeds i32 range"),
		)
	})
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

#[derive(Deserialize)]
struct DecodeSignatureRequest {
	signature: String,
}

#[derive(Serialize)]
struct DecodeSignatureResponse {
	signature: String,
	rows_written: u64,
	actions: Vec<ActionRecord>,
}

async fn open_isolated(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<OpenIsolatedRequest>,
) -> Result<Json<Value>, ApiError> {
	log_request("/orders/open-isolated", &uri, serialize_payload(&body));
	log_request("/orders/open-isolated/execute", &uri, serialize_payload(&body));
	let value = open_isolated_build(&state, &body).await?;
	Ok(Json(value))
}

async fn open_isolated_execute(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<OpenIsolatedRequest>,
) -> Result<Json<Value>, ApiError> {
	log_request("/orders/open-isolated", &uri, serialize_payload(&body));
	log_request("/orders/open-isolated/execute", &uri, serialize_payload(&body));
	let value = open_isolated_build(&state, &body).await?;
	let executed = execute_transaction(&state, value).await?;
	Ok(Json(executed))
}

async fn close_position(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<ClosePositionRequest>,
) -> Result<Json<Value>, ApiError> {
	log_request("/orders/close", &uri, serialize_payload(&body));
	log_request("/orders/close/execute", &uri, serialize_payload(&body));
	let value = close_position_build(&state, &body).await?;
	Ok(Json(value))
}

async fn close_position_execute(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<ClosePositionRequest>,
) -> Result<Json<Value>, ApiError> {
	info!("[CLOSE_POSITION_EXECUTE] Starting close position request");
	log_request("/orders/close/execute", &uri, serialize_payload(&body));
	
	info!("[CLOSE_POSITION_EXECUTE] Building close position transaction for wallet: {}, market: {}, size: {:?}", 
		body.wallet, body.market, body.size);
	
	let value = match close_position_build(&state, &body).await {
		Ok(v) => {
			let tx_preview = v.get("txBase64")
				.and_then(|v| v.as_str())
				.map(|s| {
					let len = s.len();
					if len > 50 {
						format!("{}... ({} chars)", &s[..50], len)
					} else {
						s.to_string()
					}
				})
				.unwrap_or_else(|| "N/A".to_string());
			info!("[CLOSE_POSITION_EXECUTE] Successfully built transaction (preview: {})", tx_preview);
			v
		},
		Err(e) => {
			error!("[CLOSE_POSITION_EXECUTE] Failed to build transaction: {:?}", e);
			return Err(e);
		}
	};
	
	info!("[CLOSE_POSITION_EXECUTE] Executing transaction");
	let executed = match execute_transaction(&state, value).await {
		Ok(result) => {
			// Extract and log the transaction signature
			let tx_signature = result
				.get("txSignature")
				.and_then(|v| v.as_str())
				.map(|s| s.to_string())
				.unwrap_or_else(|| "N/A".to_string());
			
			info!("[CLOSE_POSITION_EXECUTE] Transaction executed successfully");
			info!("[CLOSE_POSITION_EXECUTE] Transaction signature: {}", tx_signature);
			
			result
		},
		Err(e) => {
			error!("[CLOSE_POSITION_EXECUTE] Transaction execution failed: {:?}", e);
			return Err(e);
		}
	};
	
	// Ensure txSignature is in the response
	let response = if executed.get("txSignature").is_some() {
		executed
	} else {
		warn!("[CLOSE_POSITION_EXECUTE] Warning: txSignature missing from response");
		executed
	};
	
	info!("[CLOSE_POSITION_EXECUTE] Close position completed successfully");
	Ok(Json(response))
}

async fn decode_signature_route(
	State(state): State<AppState>,
	Json(body): Json<DecodeSignatureRequest>,
) -> Result<Json<DecodeSignatureResponse>, ApiError> {
	let signature = body.signature.trim();
	if signature.is_empty() {
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"signature is required",
		));
	}

	let (_, actions) = state
		.decoder
		.decode_signature(signature)
		.map_err(|err| {
			error!(?err, "failed to decode signature", signature);
			ApiError::new(StatusCode::BAD_GATEWAY, "failed to decode signature")
		})?;

	let rows_written = persist_actions(&state.db, &actions).await?;

	Ok(Json(DecodeSignatureResponse {
		signature: signature.to_string(),
		rows_written,
		actions,
	}))
}

async fn transfer_margin(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<TransferMarginRequest>,
) -> Result<Json<Value>, ApiError> {
	log_request("/margin/transfer", &uri, serialize_payload(&body));
	log_request("/margin/transfer/execute", &uri, serialize_payload(&body));
	let value = transfer_margin_build(&state, &body).await?;
	Ok(Json(value))
}

async fn transfer_margin_execute(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<TransferMarginRequest>,
) -> Result<Json<Value>, ApiError> {
	info!("[TRANSFER_MARGIN_EXECUTE] Starting transfer margin request");
	log_request("/margin/transfer/execute", &uri, serialize_payload(&body));
	
	info!("[TRANSFER_MARGIN_EXECUTE] Building transfer margin transaction for wallet: {}, market: {}, delta: {}", 
		body.wallet, body.market, body.delta);
	
	let value = match transfer_margin_build(&state, &body).await {
		Ok(v) => {
			let tx_preview = v.get("txBase64")
				.and_then(|v| v.as_str())
				.map(|s| {
					let len = s.len();
					if len > 50 {
						format!("{}... ({} chars)", &s[..50], len)
					} else {
						s.to_string()
					}
				})
				.unwrap_or_else(|| "N/A".to_string());
			info!("[TRANSFER_MARGIN_EXECUTE] Successfully built transaction (preview: {})", tx_preview);
			v
		},
		Err(e) => {
			error!("[TRANSFER_MARGIN_EXECUTE] Failed to build transaction: {:?}", e);
			return Err(e);
		}
	};
	
	info!("[TRANSFER_MARGIN_EXECUTE] Executing transaction");
	let executed = match execute_transaction(&state, value).await {
		Ok(result) => {
			// Extract and log the transaction signature
			let tx_signature = result
				.get("txSignature")
				.and_then(|v| v.as_str())
				.map(|s| s.to_string())
				.unwrap_or_else(|| "N/A".to_string());
			
			info!("[TRANSFER_MARGIN_EXECUTE] Transaction executed successfully");
			info!("[TRANSFER_MARGIN_EXECUTE] Transaction signature: {}", tx_signature);
			
			result
		},
		Err(e) => {
			error!("[TRANSFER_MARGIN_EXECUTE] Transaction execution failed: {:?}", e);
			return Err(e);
		}
	};
	
	info!("[TRANSFER_MARGIN_EXECUTE] Transfer margin completed successfully");
	Ok(Json(executed))
}

async fn deposit_native(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<DepositNativeRequest>,
) -> Result<Json<Value>, ApiError> {
	log_request("/margin/deposit-native", &uri, serialize_payload(&body));
	log_request("/margin/deposit-native/execute", &uri, serialize_payload(&body));
	let value = deposit_native_build(&state, &body).await?;
	Ok(Json(value))
}

async fn deposit_native_execute(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<DepositNativeRequest>,
) -> Result<Json<Value>, ApiError> {
	info!("[DEPOSIT_NATIVE_EXECUTE] Starting deposit native SOL request");
	log_request("/margin/deposit-native/execute", &uri, serialize_payload(&body));
	
	info!("[DEPOSIT_NATIVE_EXECUTE] Building deposit native transaction for wallet: {}, amount: {}, market: {:?}", 
		body.wallet, body.amount, body.market);
	
	let value = match deposit_native_build(&state, &body).await {
		Ok(v) => {
			let tx_preview = v.get("txBase64")
				.and_then(|v| v.as_str())
				.map(|s| {
					let len = s.len();
					if len > 50 {
						format!("{}... ({} chars)", &s[..50], len)
					} else {
						s.to_string()
					}
				})
				.unwrap_or_else(|| "N/A".to_string());
			info!("[DEPOSIT_NATIVE_EXECUTE] Successfully built transaction (preview: {})", tx_preview);
			v
		},
		Err(e) => {
			error!("[DEPOSIT_NATIVE_EXECUTE] Failed to build transaction: {:?}", e);
			return Err(e);
		}
	};
	
	info!("[DEPOSIT_NATIVE_EXECUTE] Executing transaction");
	let executed = match execute_transaction(&state, value).await {
		Ok(result) => {
			let tx_signature = result
				.get("txSignature")
				.and_then(|v| v.as_str())
				.map(|s| s.to_string())
				.unwrap_or_else(|| "N/A".to_string());
			
			info!("[DEPOSIT_NATIVE_EXECUTE] Transaction executed successfully");
			info!("[DEPOSIT_NATIVE_EXECUTE] Transaction signature: {}", tx_signature);
			
			result
		},
		Err(e) => {
			error!("[DEPOSIT_NATIVE_EXECUTE] Transaction execution failed: {:?}", e);
			return Err(e);
		}
	};
	
	info!("[DEPOSIT_NATIVE_EXECUTE] Deposit native completed successfully");
	Ok(Json(executed))
}

async fn deposit_token(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<DepositTokenRequest>,
) -> Result<Json<Value>, ApiError> {
	log_request("/margin/deposit-token", &uri, serialize_payload(&body));
	log_request("/margin/deposit-token/execute", &uri, serialize_payload(&body));
	let value = deposit_token_build(&state, &body).await?;
	Ok(Json(value))
}

async fn deposit_token_execute(
	State(state): State<AppState>,
	OriginalUri(uri): OriginalUri,
	Json(body): Json<DepositTokenRequest>,
) -> Result<Json<Value>, ApiError> {
	info!("[DEPOSIT_TOKEN_EXECUTE] Starting deposit token request");
	log_request("/margin/deposit-token/execute", &uri, serialize_payload(&body));
	
	info!("[DEPOSIT_TOKEN_EXECUTE] Building deposit token transaction for wallet: {}, amount: {}, market: {:?}", 
		body.wallet, body.amount, body.market);
	
	let value = match deposit_token_build(&state, &body).await {
		Ok(v) => {
			let tx_preview = v.get("txBase64")
				.and_then(|v| v.as_str())
				.map(|s| {
					let len = s.len();
					if len > 50 {
						format!("{}... ({} chars)", &s[..50], len)
					} else {
						s.to_string()
					}
				})
				.unwrap_or_else(|| "N/A".to_string());
			info!("[DEPOSIT_TOKEN_EXECUTE] Successfully built transaction (preview: {})", tx_preview);
			v
		},
		Err(e) => {
			error!("[DEPOSIT_TOKEN_EXECUTE] Failed to build transaction: {:?}", e);
			return Err(e);
		}
	};
	
	info!("[DEPOSIT_TOKEN_EXECUTE] Executing transaction");
	let executed = match execute_transaction(&state, value).await {
		Ok(result) => {
			let tx_signature = result
				.get("txSignature")
				.and_then(|v| v.as_str())
				.map(|s| s.to_string())
				.unwrap_or_else(|| "N/A".to_string());
			
			info!("[DEPOSIT_TOKEN_EXECUTE] Transaction executed successfully");
			info!("[DEPOSIT_TOKEN_EXECUTE] Transaction signature: {}", tx_signature);
			
			result
		},
		Err(e) => {
			error!("[DEPOSIT_TOKEN_EXECUTE] Transaction execution failed: {:?}", e);
			return Err(e);
		}
	};
	
	info!("[DEPOSIT_TOKEN_EXECUTE] Deposit token completed successfully");
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
	debug!("[CLOSE_POSITION_BUILD] Starting build for wallet: {}, market: {}, size: {:?}", 
		body.wallet, body.market, body.size);
	
	validate_wallet(&body.wallet)?;
	
	if let Some(size) = body.size {
		if !size.is_finite() || size <= 0.0 {
			warn!("[CLOSE_POSITION_BUILD] Invalid size provided: {}", size);
			return Err(ApiError::new(
				StatusCode::BAD_REQUEST,
				"size must be positive when provided",
			));
		}
	}

	// Build args conditionally - only include size if it's Some(value)
	// TypeScript schema expects size to be optional (undefined) or number, not null
	let args = if let Some(size) = body.size {
		json!({
			"wallet": body.wallet,
			"market": body.market,
			"size": size,
		})
	} else {
		json!({
			"wallet": body.wallet,
			"market": body.market,
		})
	};
	
	debug!("[CLOSE_POSITION_BUILD] Calling worker with args: {:?}", args);
	
	match call_worker(state, "closePosition", args, WORKER_TIMEOUT).await {
		Ok(result) => {
			debug!("[CLOSE_POSITION_BUILD] Worker returned successfully");
			Ok(result)
		},
		Err(e) => {
			error!("[CLOSE_POSITION_BUILD] Worker call failed: {:?}", e);
			Err(e)
		}
	}
}

async fn transfer_margin_build(
	state: &AppState,
	body: &TransferMarginRequest,
) -> Result<Value, ApiError> {
	debug!("[TRANSFER_MARGIN_BUILD] Starting build for wallet: {}, market: {}, delta: {}", 
		body.wallet, body.market, body.delta);
	
	validate_wallet(&body.wallet)?;
	
	if !body.delta.is_finite() || body.delta == 0.0 {
		warn!("[TRANSFER_MARGIN_BUILD] Invalid delta provided: {}", body.delta);
		return Err(ApiError::new(
			StatusCode::BAD_REQUEST,
			"delta must be a non-zero number",
		));
	}

	let operation = if body.delta > 0.0 {
		"deposit"
	} else {
		"withdraw"
	};
	info!("[TRANSFER_MARGIN_BUILD] Transfer operation: {} (delta: {})", operation, body.delta);

	let args = json!({
		"wallet": body.wallet,
		"market": body.market,
		"delta": body.delta,
	});
	
	debug!("[TRANSFER_MARGIN_BUILD] Calling worker with args: {:?}", args);
	
	match call_worker(state, "transferMargin", args, WORKER_TIMEOUT).await {
		Ok(result) => {
			debug!("[TRANSFER_MARGIN_BUILD] Worker returned successfully");
			Ok(result)
		},
		Err(e) => {
			error!("[TRANSFER_MARGIN_BUILD] Worker call failed: {:?}", e);
			Err(e)
		}
	}
}

async fn deposit_native_build(
	state: &AppState,
	body: &DepositNativeRequest,
) -> Result<Value, ApiError> {
	debug!("[DEPOSIT_NATIVE_BUILD] Starting build for wallet: {}, amount: {}, market: {:?}", 
		body.wallet, body.amount, body.market);
	
	validate_wallet(&body.wallet)?;
	
	if !body.amount.is_finite() || body.amount <= 0.0 {
		warn!("[DEPOSIT_NATIVE_BUILD] Invalid amount provided: {}", body.amount);
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
	
	debug!("[DEPOSIT_NATIVE_BUILD] Calling worker with args: {:?}", args);
	
	match call_worker(state, "depositNativeSol", args, WORKER_TIMEOUT).await {
		Ok(result) => {
			debug!("[DEPOSIT_NATIVE_BUILD] Worker returned successfully");
			Ok(result)
		},
		Err(e) => {
			error!("[DEPOSIT_NATIVE_BUILD] Worker call failed: {:?}", e);
			Err(e)
		}
	}
}

async fn deposit_token_build(
	state: &AppState,
	body: &DepositTokenRequest,
) -> Result<Value, ApiError> {
	debug!("[DEPOSIT_TOKEN_BUILD] Starting build for wallet: {}, amount: {}, market: {:?}", 
		body.wallet, body.amount, body.market);
	
	validate_wallet(&body.wallet)?;
	
	if !body.amount.is_finite() || body.amount <= 0.0 {
		warn!("[DEPOSIT_TOKEN_BUILD] Invalid amount provided: {}", body.amount);
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
	
	debug!("[DEPOSIT_TOKEN_BUILD] Calling worker with args: {:?}", args);
	
	match call_worker(state, "depositToken", args, WORKER_TIMEOUT).await {
		Ok(result) => {
			debug!("[DEPOSIT_TOKEN_BUILD] Worker returned successfully");
			Ok(result)
		},
		Err(e) => {
			error!("[DEPOSIT_TOKEN_BUILD] Worker call failed: {:?}", e);
			Err(e)
		}
	}
}

async fn get_positions(
	State(state): State<AppState>,
	Query(query): Query<WalletQuery>,
	OriginalUri(uri): OriginalUri,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
  log_request("/positions", &uri, serialize_payload(&query));
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
	OriginalUri(uri): OriginalUri,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
  log_request("/positions/details", &uri, serialize_payload(&query));
	let args = json!({ "wallet": query.wallet });
	state
		.ipc
		.call("getPositionDetails", args, Duration::from_secs(5))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn get_balances(
	State(state): State<AppState>,
	Query(query): Query<WalletQuery>,
	OriginalUri(uri): OriginalUri,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
  log_request("/balances", &uri, serialize_payload(&query));
	let args = json!({ "wallet": query.wallet });
	state
		.ipc
		.call("getBalances", args, Duration::from_secs(5))
		.await
		.map(Json)
		.map_err(map_ipc_error)
}

async fn get_trades(
	State(state): State<AppState>,
	Query(query): Query<WalletQuery>,
	OriginalUri(uri): OriginalUri,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
  log_request("/trade-history", &uri, serialize_payload(&query));
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
	OriginalUri(uri): OriginalUri,
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
	OriginalUri(uri): OriginalUri,
) -> Result<Json<Value>, ApiError> {
	validate_wallet(&query.wallet)?;
  log_request(
		"/positions/isolated-balance",
		&uri,
		serialize_payload(&query),
	);
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
	OriginalUri(uri): OriginalUri,
) -> Result<Json<Value>, ApiError> {
  log_request("/server/public-key", &uri, None);
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

fn log_request(label: &str, uri: &Uri, payload: Option<String>) {
	let body_json = payload.unwrap_or_else(|| "{}".to_string());
	tracing::info!(url = %uri, event = label, payload = %body_json, "incoming request");
}

fn serialize_payload<T: serde::Serialize>(value: &T) -> Option<String> {
	serde_json::to_string(value).ok()
}
