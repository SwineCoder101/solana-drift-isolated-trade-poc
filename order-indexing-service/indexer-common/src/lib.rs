use std::{collections::HashMap, str::FromStr};

use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use solana_program::pubkey::Pubkey;
use solana_transaction_status::{
    EncodedTransaction, EncodedTransactionWithStatusMeta, UiMessage, UiParsedMessage, UiRawMessage,
    UiTransactionEncoding, UiTransactionStatusMeta,
};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tracing::warn;

const LAMPORTS_PER_SOL: f64 = 1_000_000_000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeRecord {
    pub wallet: String,
    pub signature: String,
    pub action: String,
    pub amount: f64,
    pub asset_symbol: String,
    pub asset_mint: String,
    pub slot: u64,
    pub block_time: Option<DateTime<Utc>>,
}

pub async fn connect_pool(database_url: &str) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await
        .context("failed to connect to database")
}

pub async fn insert_trade(pool: &PgPool, trade: &TradeRecord) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO trade_history (wallet, signature, action, amount, asset_symbol, asset_mint, slot, block_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (signature) DO NOTHING
        "#,
    )
    .bind(&trade.wallet)
    .bind(&trade.signature)
    .bind(&trade.action)
    .bind(trade.amount)
    .bind(&trade.asset_symbol)
    .bind(&trade.asset_mint)
    .bind(trade.slot as i64)
    .bind(trade.block_time)
    .execute(pool)
    .await
    .context("failed to insert trade")?;

    Ok(())
}

pub fn parse_trade_from_tx(
    tx: &EncodedTransactionWithStatusMeta,
    wallet: &Pubkey,
    drift_program: &Pubkey,
    drift_account: &Pubkey,
) -> Option<TradeRecord> {
    let meta = tx.transaction.meta.as_ref()?;
    let logs = meta.log_messages.as_ref()?;
    let (signature, message) = match &tx.transaction.transaction {
        EncodedTransaction::Json(parsed) => {
            let sig = parsed.signatures.get(0)?.clone();
            (sig, &parsed.message)
        }
        _ => return None,
    };
    if !logs.iter().any(|log| log.contains(&drift_program.to_string())) {
        return None;
    }

    let wallet_str = wallet.to_string();
    let drift_account_str = drift_account.to_string();
    if !message_mentions(message, &wallet_str) && !message_mentions(message, &drift_account_str) {
        return None;
    }

    let balance_change = compute_balance_change(message, meta, &wallet_str);
    let (amount, mint) = balance_change.unwrap_or((0.0, "SOL".to_string()));

    let action = detect_action(logs);
    let symbol = resolve_symbol(&mint);

    let block_time = tx
        .block_time
        .and_then(|ts| Utc.timestamp_opt(ts, 0).single());

    Some(TradeRecord {
        wallet: wallet_str,
        signature,
        action,
        amount,
        asset_symbol: symbol,
        asset_mint: mint,
        slot: tx.slot,
        block_time,
    })
}

fn compute_balance_change(
    message: &UiMessage,
    meta: &UiTransactionStatusMeta,
    wallet: &str,
) -> Option<(f64, String)> {
    if let Some(idx) = account_index(message, wallet) {
        if let (Some(pre), Some(post)) = (meta.pre_balances.get(idx), meta.post_balances.get(idx)) {
            let diff = *post as i128 - *pre as i128;
            if diff != 0 {
                return Some((diff as f64 / LAMPORTS_PER_SOL, "SOL".to_string()));
            }
        }
    }

    let mut pre_map: HashMap<(&str, &str), (i128, u8)> = HashMap::new();
    for bal in &meta.pre_token_balances {
        if let Some(owner) = bal.owner.as_deref() {
            if owner == wallet {
                if let Ok(amount) = bal.ui_token_amount.amount.parse::<i128>() {
                    pre_map.insert(
                        (owner, bal.mint.as_str()),
                        (amount, bal.ui_token_amount.decimals),
                    );
                }
            }
        }
    }

    for bal in &meta.post_token_balances {
        if let Some(owner) = bal.owner.as_deref() {
            if owner != wallet {
                continue;
            }
            let post_amount = match bal.ui_token_amount.amount.parse::<i128>() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let decimals = bal.ui_token_amount.decimals;
            let (pre_amount, _) = pre_map
                .get(&(owner, bal.mint.as_str()))
                .copied()
                .unwrap_or((0, decimals));
            let diff = post_amount - pre_amount;
            if diff != 0 {
                let denom = 10f64.powi(decimals as i32);
                return Some((diff as f64 / denom, bal.mint.clone()));
            }
        }
    }

    None
}

fn detect_action(logs: &[String]) -> String {
    for log in logs {
        if log.contains("DepositIntoIsolatedPerpPosition") {
            return "deposit_isolated".into();
        }
        if log.contains("TransferIsolatedPerpPositionDeposit") {
            return "transfer_isolated_margin".into();
        }
        if log.contains("OpenPerp") || log.contains("PlacePerpOrder") {
            return "open_perp".into();
        }
        if log.contains("ClosePosition") {
            return "close_perp".into();
        }
        if log.contains("WithdrawFromIsolatedPerpPosition") {
            return "withdraw_isolated".into();
        }
    }

    "unknown".into()
}

fn message_mentions(message: &UiMessage, needle: &str) -> bool {
    account_index(message, needle).is_some()
}

fn account_index(message: &UiMessage, needle: &str) -> Option<usize> {
    match message {
        UiMessage::Parsed(UiParsedMessage { account_keys, .. }) => account_keys
            .iter()
            .position(|entry| entry.pubkey == needle),
        UiMessage::Raw(UiRawMessage { account_keys, .. }) => {
            account_keys.iter().position(|key| key == needle)
        }
    }
}

fn resolve_symbol(mint: &str) -> String {
    match mint {
        "So11111111111111111111111111111111111111112" => "SOL".into(),
        "Es9vMFrzaCERmJfrF4H2FYD4UDNDnhhye5Qz9mZzNKc" => "USDT".into(),
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" => "USDC".into(),
        other => other.into(),
    }
}

pub fn parse_pubkey(value: &str, label: &str) -> Result<Pubkey> {
    Pubkey::from_str(value).with_context(|| format!("invalid {label} pubkey"))
}

pub fn ui_encoding() -> UiTransactionEncoding {
    UiTransactionEncoding::JsonParsed
}

pub fn log_decoding_warning(signature: &str, err: &str) {
    warn!(%signature, %err, "failed to decode transaction");
}
