use axum::{Json, Router, response::IntoResponse, routing::get};
use serde::Serialize;

pub fn routes() -> Router {
    Router::new()
        .route("/me", get(user_profile))
        .route("/mock", get(mock_user))
}

async fn user_profile() -> impl IntoResponse {
    Json(user_profile_payload())
}

async fn mock_user() -> impl IntoResponse {
    Json(mock_user_payload())
}

pub fn user_profile_payload() -> UserProfile {
    UserProfile {
        name: "demo-user".to_string(),
        wallet_count: 0,
    }
}

pub fn mock_user_payload() -> UserProfile {
    UserProfile {
        name: "mock-user".to_string(),
        wallet_count: 2,
    }
}

#[derive(Debug, Serialize)]
pub struct UserProfile {
    pub name: String,
    pub wallet_count: u8,
}
