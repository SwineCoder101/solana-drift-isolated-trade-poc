use axum::{Json, response::IntoResponse};
use serde::Serialize;

/// Simple healthcheck response for uptime monitoring.
pub async fn healthcheck() -> impl IntoResponse {
    Json(HealthResponse::ok())
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
}

impl HealthResponse {
    pub fn ok() -> Self {
        Self {
            status: "ok".to_string(),
        }
    }
}
