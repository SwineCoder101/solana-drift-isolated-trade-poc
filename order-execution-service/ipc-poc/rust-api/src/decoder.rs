use std::{collections::HashMap, env, fmt, str::FromStr, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use base64::prelude::*;
use borsh::BorshDeserialize;
use once_cell::sync::Lazy;
use reqwest::Client as ReqwestClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_client::{rpc_client::RpcClient, rpc_config::RpcTransactionConfig};
use solana_rpc_client::{http_sender::HttpSender, rpc_client::RpcClientConfig};
use solana_sdk::{
    commitment_config::CommitmentConfig, instruction::CompiledInstruction,
    message::VersionedMessage, pubkey::Pubkey, signature::Signature,
};
use solana_transaction_status::{
    option_serializer::OptionSerializer, UiLoadedAddresses, UiTransactionEncoding,
    UiTransactionStatusMeta, UiTransactionTokenBalance,
};

const DEFAULT_DRIFT_PROGRAM: &str = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";

static DEPOSIT_DISC: Lazy<[u8; 8]> =
    Lazy::new(|| anchor_discriminator("deposit_into_isolated_perp_position"));
static WITHDRAW_DISC: Lazy<[u8; 8]> =
    Lazy::new(|| anchor_discriminator("withdraw_from_isolated_perp_position"));
static PLACE_PERP_ORDER_DISC: Lazy<[u8; 8]> =
    Lazy::new(|| anchor_discriminator("place_perp_order"));

#[derive(Clone)]
pub struct DriftDecoder {
    client: Arc<RpcClient>,
    drift_program: Pubkey,
}

impl DriftDecoder {
    pub fn from_env() -> Result<Self> {
        let rpc_url =
            env::var("RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
        let drift_program =
            env::var("DRIFT_PROGRAM_ID").unwrap_or_else(|_| DEFAULT_DRIFT_PROGRAM.to_string());
        let drift_program = Pubkey::from_str(&drift_program).context("invalid DRIFT_PROGRAM_ID")?;
        Self::new(rpc_url, drift_program)
    }

    pub fn new(rpc_url: impl Into<String>, drift_program: Pubkey) -> Result<Self> {
        let client = build_rpc_client(rpc_url.into(), CommitmentConfig::confirmed())?;
        Ok(Self {
            client: Arc::new(client),
            drift_program,
        })
    }

    pub fn decode_signature(&self, sig_str: &str) -> Result<(SignatureDump, Vec<ActionRecord>)> {
        let signature = Signature::from_str(sig_str).context("invalid signature")?;
        let config = RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            max_supported_transaction_version: Some(0),
        };

        let tx = self
            .client
            .get_transaction_with_config(&signature, config)
            .with_context(|| format!("fetching transaction {sig_str}"))?;

        let meta = tx
            .transaction
            .meta
            .as_ref()
            .context("transaction missing meta")?;
        let token_lookup = build_token_mint_lookup(meta);

        let Some(versioned_tx) = tx.transaction.transaction.decode() else {
            bail!("transaction payload is not binary encoded");
        };
        let message = &versioned_tx.message;
        let account_keys = collect_account_keys(message, Some(meta))?;

        let mut instruction_dumps = Vec::new();
        let mut action_records = Vec::new();
        let mut drift_ix_found = false;
        for (ix_idx, ix) in message.instructions().iter().enumerate() {
            let program_idx = ix.program_id_index as usize;
            let program_id = account_keys
                .get(program_idx)
                .copied()
                .context("program index out of bounds")?;
            if program_id != self.drift_program {
                continue;
            }

            drift_ix_found = true;

            let decode_result = match decode_drift_instruction(&ix.data) {
                Ok(res) => res,
                Err(err) => {
                    tracing::error!(?err, signature = %sig_str, ix_idx, "decode error");
                    None
                }
            };

            let kind_label = decode_result
                .as_ref()
                .map(|decoded| decoded.kind.to_string());
            let args_value = decode_result.as_ref().map(|decoded| decoded.args.clone());

            let accounts = collect_account_dump(message, ix, &account_keys, kind_label.as_deref())?;
            if let Some(decoded) = decode_result.as_ref() {
                if let Some(record) = build_action_record(
                    sig_str,
                    tx.slot,
                    tx.block_time,
                    ix_idx,
                    decoded,
                    &accounts,
                    &token_lookup,
                )? {
                    action_records.push(record);
                }
            }

            instruction_dumps.push(InstructionDump {
                index: ix_idx,
                discriminator: format_discriminator(&ix.data),
                raw_data_b64: BASE64_STANDARD.encode(&ix.data),
                data_len: ix.data.len(),
                program_id: program_id.to_string(),
                kind: kind_label,
                args: args_value,
                accounts,
            });
        }

        if !drift_ix_found {
            tracing::warn!(signature = %sig_str, "no drift instructions");
        }

        Ok((
            SignatureDump {
                signature: sig_str.to_string(),
                slot: tx.slot,
                block_time: tx.block_time,
                instructions: instruction_dumps,
            },
            action_records,
        ))
    }
}

fn build_rpc_client(url: String, commitment: CommitmentConfig) -> Result<RpcClient> {
    let timeout = Duration::from_secs(30);
    let reqwest_client = ReqwestClient::builder()
        .no_proxy()
        .default_headers(HttpSender::default_headers())
        .timeout(timeout)
        .pool_idle_timeout(timeout)
        .build()
        .context("failed to initialize reqwest client without system proxy lookup")?;

    Ok(RpcClient::new_sender(
        HttpSender::new_with_client(url, reqwest_client),
        RpcClientConfig::with_commitment(commitment),
    ))
}

fn collect_account_keys(
    message: &VersionedMessage,
    meta: Option<&UiTransactionStatusMeta>,
) -> Result<Vec<Pubkey>> {
    let mut keys = message.static_account_keys().to_vec();
    if let Some(meta) = meta {
        if let OptionSerializer::Some(UiLoadedAddresses { writable, readonly }) =
            &meta.loaded_addresses
        {
            for key_str in writable.iter().chain(readonly.iter()) {
                let key = Pubkey::from_str(key_str)
                    .with_context(|| format!("invalid loaded address {key_str}"))?;
                keys.push(key);
            }
        }
    }

    Ok(keys)
}

fn collect_account_dump(
    message: &VersionedMessage,
    ix: &CompiledInstruction,
    account_keys: &[Pubkey],
    kind_label: Option<&str>,
) -> Result<Vec<AccountDump>> {
    let roles: Vec<&str> = kind_label
        .and_then(|label| DriftIxKind::from_str(label).ok())
        .map(|kind| kind.account_names().to_vec())
        .unwrap_or_default();

    let mut accounts = Vec::with_capacity(ix.accounts.len());
    for (position, account_idx) in ix.accounts.iter().enumerate() {
        let global_idx = *account_idx as usize;
        let key = account_keys
            .get(global_idx)
            .copied()
            .context("account index out of bounds")?;
        accounts.push(AccountDump {
            position,
            message_index: global_idx,
            pubkey: key.to_string(),
            is_signer: message.is_signer(global_idx),
            is_writable: message.is_maybe_writable(global_idx),
            role: roles.get(position).map(|s| s.to_string()),
        });
    }

    Ok(accounts)
}

fn decode_drift_instruction(data: &[u8]) -> Result<Option<DecodedDriftArgs>> {
    if data.len() < 8 {
        bail!("instruction shorter than anchor discriminator");
    }
    let (disc, rest) = data.split_at(8);
    let disc: [u8; 8] = disc.try_into().unwrap();

    if disc == *DEPOSIT_DISC {
        let args = IsolatedPerpMovementArgs::try_from_slice(rest)?;
        let json_args = json!({
            "spotMarketIndex": args.spot_market_index,
            "perpMarketIndex": args.perp_market_index,
            "amount": args.amount,
        });
        return Ok(Some(DecodedDriftArgs {
            kind: DriftIxKind::DepositIntoIsolatedPerpPosition,
            args: json_args,
            details: DriftDecodedDetails::IsolatedMovement(args),
        }));
    }

    if disc == *WITHDRAW_DISC {
        let args = IsolatedPerpMovementArgs::try_from_slice(rest)?;
        let json_args = json!({
            "spotMarketIndex": args.spot_market_index,
            "perpMarketIndex": args.perp_market_index,
            "amount": args.amount,
        });
        return Ok(Some(DecodedDriftArgs {
            kind: DriftIxKind::WithdrawFromIsolatedPerpPosition,
            args: json_args,
            details: DriftDecodedDetails::IsolatedMovement(args),
        }));
    }

    if disc == *PLACE_PERP_ORDER_DISC {
        let params = OrderParams::try_from_slice(rest)?;
        let json_args = order_params_to_json(&params);
        return Ok(Some(DecodedDriftArgs {
            kind: DriftIxKind::PlacePerpOrder,
            args: json_args,
            details: DriftDecodedDetails::PlacePerpOrder(params),
        }));
    }

    Ok(None)
}

fn order_params_to_json(params: &OrderParams) -> Value {
    json!({
        "orderType": params.order_type.as_str(),
        "marketType": params.market_type.as_str(),
        "direction": params.direction.as_str(),
        "userOrderId": params.user_order_id,
        "baseAssetAmount": params.base_asset_amount,
        "price": params.price,
        "marketIndex": params.market_index,
        "reduceOnly": params.reduce_only,
        "postOnly": params.post_only.as_str(),
        "bitFlags": {
            "raw": params.bit_flags,
            "labels": order_bit_flag_labels(params.bit_flags),
        },
        "maxTs": params.max_ts,
        "triggerPrice": params.trigger_price,
        "triggerCondition": params.trigger_condition.as_str(),
        "oraclePriceOffset": params.oracle_price_offset,
        "auctionDuration": params.auction_duration,
        "auctionStartPrice": params.auction_start_price,
        "auctionEndPrice": params.auction_end_price,
    })
}

fn format_discriminator(data: &[u8]) -> String {
    let take = data.len().min(8);
    let mut out = String::new();
    for (idx, byte) in data[..take].iter().enumerate() {
        if idx > 0 {
            out.push(':');
        }
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn order_bit_flag_labels(bit_flags: u8) -> Vec<&'static str> {
    let mut labels = Vec::new();
    if bit_flags & 0b01 != 0 {
        labels.push("ImmediateOrCancel");
    }
    if bit_flags & 0b10 != 0 {
        labels.push("UpdateHighLeverageMode");
    }
    labels
}

#[derive(Debug)]
struct DecodedDriftArgs {
    kind: DriftIxKind,
    args: Value,
    details: DriftDecodedDetails,
}

#[derive(Debug)]
enum DriftDecodedDetails {
    IsolatedMovement(IsolatedPerpMovementArgs),
    PlacePerpOrder(OrderParams),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SignatureDump {
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
    pub instructions: Vec<InstructionDump>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstructionDump {
    pub index: usize,
    pub discriminator: String,
    pub raw_data_b64: String,
    pub data_len: usize,
    pub program_id: String,
    pub kind: Option<String>,
    pub args: Option<Value>,
    pub accounts: Vec<AccountDump>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AccountDump {
    pub position: usize,
    #[serde(rename = "accountIndex")]
    pub message_index: usize,
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
    pub role: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActionRecord {
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
    pub instruction_index: usize,
    pub action_type: String,
    pub market_index: Option<u16>,
    pub perp_market_index: Option<u16>,
    pub spot_market_index: Option<u16>,
    pub direction: Option<String>,
    pub base_asset_amount: Option<u64>,
    pub price: Option<u64>,
    pub reduce_only: Option<bool>,
    pub leverage: Option<f64>,
    pub amount: Option<u64>,
    pub token_account: Option<String>,
    pub token_mint: Option<String>,
    pub token_amount: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum DriftIxKind {
    DepositIntoIsolatedPerpPosition,
    WithdrawFromIsolatedPerpPosition,
    PlacePerpOrder,
}

impl DriftIxKind {
    fn from_str(label: &str) -> Result<Self, ()> {
        match label {
            "depositIntoIsolatedPerpPosition" => Ok(Self::DepositIntoIsolatedPerpPosition),
            "withdrawFromIsolatedPerpPosition" => Ok(Self::WithdrawFromIsolatedPerpPosition),
            "placePerpOrder" => Ok(Self::PlacePerpOrder),
            _ => Err(()),
        }
    }

    fn account_names(&self) -> Vec<&'static str> {
        match self {
            DriftIxKind::DepositIntoIsolatedPerpPosition => vec![
                "state",
                "user",
                "userStats",
                "authority",
                "spotMarketVault",
                "userTokenAccount",
                "tokenProgram",
            ],
            DriftIxKind::WithdrawFromIsolatedPerpPosition => vec![
                "state",
                "user",
                "userStats",
                "authority",
                "spotMarketVault",
                "driftSigner",
                "userTokenAccount",
                "tokenProgram",
            ],
            DriftIxKind::PlacePerpOrder => vec!["state", "user", "authority"],
        }
    }
}

impl fmt::Display for DriftIxKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DriftIxKind::DepositIntoIsolatedPerpPosition => {
                write!(f, "depositIntoIsolatedPerpPosition")
            }
            DriftIxKind::WithdrawFromIsolatedPerpPosition => {
                write!(f, "withdrawFromIsolatedPerpPosition")
            }
            DriftIxKind::PlacePerpOrder => write!(f, "placePerpOrder"),
        }
    }
}

#[derive(Debug, BorshDeserialize, Clone, Copy)]
struct IsolatedPerpMovementArgs {
    spot_market_index: u16,
    perp_market_index: u16,
    amount: u64,
}

#[derive(Debug, BorshDeserialize, Clone)]
struct OrderParams {
    order_type: OrderType,
    market_type: MarketType,
    direction: PositionDirection,
    user_order_id: u8,
    base_asset_amount: u64,
    price: u64,
    market_index: u16,
    reduce_only: bool,
    post_only: PostOnlyParam,
    bit_flags: u8,
    max_ts: Option<i64>,
    trigger_price: Option<u64>,
    trigger_condition: OrderTriggerCondition,
    oracle_price_offset: Option<i32>,
    auction_duration: Option<u8>,
    auction_start_price: Option<i64>,
    auction_end_price: Option<i64>,
}

#[derive(Debug, Clone, Copy, BorshDeserialize)]
enum OrderType {
    Market,
    Limit,
    TriggerMarket,
    TriggerLimit,
    Oracle,
}

impl OrderType {
    fn as_str(&self) -> &'static str {
        match self {
            OrderType::Market => "Market",
            OrderType::Limit => "Limit",
            OrderType::TriggerMarket => "TriggerMarket",
            OrderType::TriggerLimit => "TriggerLimit",
            OrderType::Oracle => "Oracle",
        }
    }
}

#[derive(Debug, Clone, Copy, BorshDeserialize)]
enum MarketType {
    Spot,
    Perp,
}

impl MarketType {
    fn as_str(&self) -> &'static str {
        match self {
            MarketType::Spot => "Spot",
            MarketType::Perp => "Perp",
        }
    }
}

#[derive(Debug, Clone, Copy, BorshDeserialize)]
enum PositionDirection {
    Long,
    Short,
}

impl PositionDirection {
    fn as_str(&self) -> &'static str {
        match self {
            PositionDirection::Long => "Long",
            PositionDirection::Short => "Short",
        }
    }
}

#[derive(Debug, Clone, Copy, BorshDeserialize)]
enum PostOnlyParam {
    None,
    MustPostOnly,
    TryPostOnly,
    Slide,
}

impl PostOnlyParam {
    fn as_str(&self) -> &'static str {
        match self {
            PostOnlyParam::None => "None",
            PostOnlyParam::MustPostOnly => "MustPostOnly",
            PostOnlyParam::TryPostOnly => "TryPostOnly",
            PostOnlyParam::Slide => "Slide",
        }
    }
}

#[derive(Debug, Clone, Copy, BorshDeserialize)]
enum OrderTriggerCondition {
    Above,
    Below,
    TriggeredAbove,
    TriggeredBelow,
}

impl OrderTriggerCondition {
    fn as_str(&self) -> &'static str {
        match self {
            OrderTriggerCondition::Above => "Above",
            OrderTriggerCondition::Below => "Below",
            OrderTriggerCondition::TriggeredAbove => "TriggeredAbove",
            OrderTriggerCondition::TriggeredBelow => "TriggeredBelow",
        }
    }
}

fn anchor_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}"));
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

fn build_token_mint_lookup(meta: &UiTransactionStatusMeta) -> HashMap<usize, String> {
    let mut map = HashMap::new();
    let mut ingest = |balances: &OptionSerializer<Vec<UiTransactionTokenBalance>>| {
        if let OptionSerializer::Some(list) = balances {
            for balance in list {
                map.entry(balance.account_index as usize)
                    .or_insert_with(|| balance.mint.clone());
            }
        }
    };
    ingest(&meta.pre_token_balances);
    ingest(&meta.post_token_balances);
    map
}

fn build_action_record(
    signature: &str,
    slot: u64,
    block_time: Option<i64>,
    instruction_index: usize,
    decoded: &DecodedDriftArgs,
    accounts: &[AccountDump],
    token_lookup: &HashMap<usize, String>,
) -> Result<Option<ActionRecord>> {
    let action_type = decoded.kind.to_string();
    let base_record = |market_index: Option<u16>,
                       perp_market_index: Option<u16>,
                       spot_market_index: Option<u16>,
                       direction: Option<String>,
                       base_asset_amount: Option<u64>,
                       price: Option<u64>,
                       reduce_only: Option<bool>,
                       amount: Option<u64>,
                       token_account: Option<String>,
                       token_mint: Option<String>| {
        ActionRecord {
            signature: signature.to_string(),
            slot,
            block_time,
            instruction_index,
            action_type: action_type.clone(),
            market_index,
            perp_market_index,
            spot_market_index,
            direction,
            base_asset_amount,
            price,
            reduce_only,
            leverage: None,
            amount,
            token_account,
            token_mint,
            token_amount: amount,
        }
    };

    let record = match &decoded.details {
        DriftDecodedDetails::IsolatedMovement(args) => {
            let token_account = accounts
                .iter()
                .find(|acc| acc.role.as_deref() == Some("userTokenAccount"));
            let token_account_pubkey = token_account.map(|acc| acc.pubkey.clone());
            let token_mint = token_account
                .and_then(|acc| token_lookup.get(&acc.message_index))
                .cloned();

            base_record(
                Some(args.perp_market_index),
                Some(args.perp_market_index),
                Some(args.spot_market_index),
                None,
                None,
                None,
                None,
                Some(args.amount),
                token_account_pubkey,
                token_mint,
            )
        }
        DriftDecodedDetails::PlacePerpOrder(params) => base_record(
            Some(params.market_index),
            if matches!(params.market_type, MarketType::Perp) {
                Some(params.market_index)
            } else {
                None
            },
            if matches!(params.market_type, MarketType::Spot) {
                Some(params.market_index)
            } else {
                None
            },
            Some(params.direction.as_str().to_string()),
            Some(params.base_asset_amount),
            Some(params.price),
            Some(params.reduce_only),
            None,
            None,
            None,
        ),
    };

    Ok(Some(record))
}
