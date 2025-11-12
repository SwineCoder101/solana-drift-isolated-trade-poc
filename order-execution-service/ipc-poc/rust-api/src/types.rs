use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
pub struct OpenIsolatedRequest {
    pub wallet: String,
    pub market: String,
    pub size: f64,
    pub leverage: f64,
    pub margin: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ClosePositionRequest {
    pub wallet: String,
    pub market: String,
    pub size: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TransferMarginRequest {
    pub wallet: String,
    pub market: String,
    pub delta: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct IsolatedBalanceQuery {
    pub wallet: String,
    pub market: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DepositNativeRequest {
    pub wallet: String,
    pub amount: f64,
    pub market: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DepositTokenRequest {
    pub wallet: String,
    pub amount: f64,
    pub market: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WalletQuery {
    pub wallet: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MarketQuery {
    pub symbol: String,
}

#[derive(Debug, Serialize)]
pub struct ApiErrorBody<'a> {
    pub error: &'a str,
}
