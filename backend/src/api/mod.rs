use axum::response::IntoResponse;
use axum::{Json, Router, routing::get};
use serde::Serialize;

pub mod order;
pub mod user;

pub fn router() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/orders", order::routes())
        .nest("/users", user::routes())
}

async fn health() -> impl IntoResponse {
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
