use std::{collections::HashSet, str::FromStr};

use anyhow::{Context, Result};
use dotenvy::dotenv;
use rust_api::{db, decoder::DriftDecoder};
use solana_client::rpc_client::RpcClient;
use solana_rpc_client::rpc_client::GetConfirmedSignaturesForAddress2Config;
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey, signature::Signature};

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();
    let rpc_url = std::env::var("RPC_URL")
        .unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".to_string());
    let wallet_str = std::env::var("ADMIN_WALLET").context("ADMIN_WALLET not set")?;
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let fetch_limit: usize = std::env::var("BACKFILL_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);

    let wallet = Pubkey::from_str(&wallet_str).context("invalid ADMIN_WALLET")?;
    let rpc = RpcClient::new_with_commitment(rpc_url.clone(), CommitmentConfig::confirmed());
    let decoder = DriftDecoder::from_env()?;
    let (db_client, _db_handle) = db::connect(&database_url).await?;
    db::run_migrations(db_client.as_ref()).await?;

    println!("Fetching signatures for {wallet_str} via {rpc_url}");
    let signatures = fetch_signatures(&rpc, &wallet, fetch_limit)?;
    println!("Fetched {} signatures", signatures.len());

    let mut total_rows = 0u64;
    for signature in signatures {
        match decoder.decode_signature(&signature) {
            Ok((_, actions)) => {
                if actions.is_empty() {
                    continue;
                }
                match db::insert_actions(db_client.as_ref(), &actions).await {
                    Ok(rows) => {
                        total_rows += rows;
                        println!("{signature}: inserted {rows} rows");
                    }
                    Err(err) => {
                        eprintln!("{signature}: database insert failed: {err:?}");
                    }
                }
            }
            Err(err) => {
                eprintln!("{signature}: decode failed: {err:?}");
            }
        }
    }

    println!("Done. Inserted {total_rows} rows.");
    Ok(())
}

fn fetch_signatures(client: &RpcClient, wallet: &Pubkey, max: usize) -> Result<Vec<String>> {
    let mut before: Option<Signature> = None;
    let mut signatures = Vec::new();
    let mut seen = HashSet::new();

    while signatures.len() < max {
        let remaining = max - signatures.len();
        let config = GetConfirmedSignaturesForAddress2Config {
            before: before.clone(),
            until: None,
            limit: Some(remaining.min(1000)),
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        };
        let batch = client
            .get_signatures_for_address_with_config(wallet, config)
            .context("failed to fetch signatures for wallet")?;
        if batch.is_empty() {
            break;
        }
        before = batch
            .last()
            .and_then(|entry| Signature::from_str(&entry.signature).ok());
        for entry in batch {
            if seen.insert(entry.signature.clone()) {
                signatures.push(entry.signature);
                if signatures.len() >= max {
                    break;
                }
            }
        }
    }

    Ok(signatures)
}
