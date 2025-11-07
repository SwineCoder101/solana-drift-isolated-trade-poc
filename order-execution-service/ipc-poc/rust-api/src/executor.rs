use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use bs58;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::RpcSendTransactionConfig;
use solana_client::client_error::ClientError;
use solana_client::rpc_request::{RpcError, RpcResponseErrorData};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::signature::Signature;
use solana_sdk::signer::keypair::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::{Transaction, VersionedTransaction};
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::{error, info};

#[derive(Debug, Error)]
pub enum ExecutorError {
	#[error("missing SERVER_PRIVATE_KEY env var")]
	MissingKey,
	#[error("invalid private key: {0}")]
	InvalidKey(String),
	#[error("decode error: {0}")]
	Decode(String),
	#[error("rpc error: {0}")]
	Rpc(String),
}

pub struct TxExecutor {
	rpc: RpcClient,
	keypair: Arc<Keypair>,
	lock: Mutex<()>,
}

impl TxExecutor {
	pub fn new(rpc_url: String, keypair: Keypair) -> Self {
		Self {
			rpc: RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed()),
			keypair: Arc::new(keypair),
			lock: Mutex::new(()),
		}
	}

	pub fn from_env() -> Result<Self, ExecutorError> {
		let rpc_url =
			std::env::var("RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
		let key_str = std::env::var("SERVER_PRIVATE_KEY").map_err(|_| ExecutorError::MissingKey)?;
		let keypair = load_keypair(&key_str).map_err(|err| ExecutorError::InvalidKey(err))?;
		Ok(Self::new(rpc_url, keypair))
	}

	pub fn public_key_base58(&self) -> String {
		self.keypair.pubkey().to_string()
	}

	pub async fn execute(&self, tx_base64: &str) -> Result<Signature, ExecutorError> {
		let _guard = self.lock.lock().await;
		let bytes = STANDARD
			.decode(tx_base64)
			.map_err(|err| ExecutorError::Decode(err.to_string()))?;
		let mut tx: VersionedTransaction =
			bincode::deserialize(&bytes).map_err(|err| ExecutorError::Decode(err.to_string()))?;
		// Sign the transaction using the Signer trait
		let message = tx.message.serialize();
		let signature = self.keypair.as_ref().try_sign_message(&message)
			.map_err(|err| ExecutorError::Decode(format!("signing error: {err}")))?;
		// Update the transaction signatures
		if let Some(first_sig) = tx.signatures.first_mut() {
			*first_sig = signature;
		}
		let signature = tx.signatures[0];

		match self
			.rpc
			.send_and_confirm_transaction_with_spinner_and_config(
				&tx,
				CommitmentConfig::confirmed(),
				RpcSendTransactionConfig {
					skip_preflight: false,
					preflight_commitment: Some(CommitmentConfig::confirmed().commitment),
					..RpcSendTransactionConfig::default()
				},
			)
			.await
		{
			Ok(_) => {
				info!(%signature, "transaction executed");
				Ok(signature)
			}
			Err(err) => {
				log_rpc_error(&err);
				Err(ExecutorError::Rpc(err.to_string()))
			}
		}
	}
}

fn log_rpc_error(err: &ClientError) {
	let err_str = err.to_string();
	if err_str.contains("SendTransactionPreflightFailure") {
		error!(error = ?err, "transaction preflight failure");
	} else {
		error!(error = ?err, "rpc error");
	}
}

fn load_keypair(key_str: &str) -> Result<Keypair, String> {
	let trimmed = key_str.trim();
	if trimmed.is_empty() {
		return Err("empty private key".into());
	}
	if trimmed.starts_with('[') {
		let bytes: Vec<u8> = serde_json::from_str(trimmed)
			.map_err(|err| format!("invalid json array: {err}"))?;
		return Keypair::from_bytes(&bytes).map_err(|err| err.to_string());
	}
	if trimmed.contains(',') {
		let mut bytes = Vec::new();
		for part in trimmed.split(',') {
			let value: u8 = part
				.trim()
				.parse()
				.map_err(|err| format!("invalid byte '{part}': {err}"))?;
			bytes.push(value);
		}
		return Keypair::from_bytes(&bytes).map_err(|err| err.to_string());
	}
	let decoded = bs58::decode(trimmed)
		.into_vec()
		.map_err(|err| format!("invalid base58: {err}"))?;
	Keypair::from_bytes(&decoded).map_err(|err| err.to_string())
}
