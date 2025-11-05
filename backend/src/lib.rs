use axum::{Router, http::Method};
use tower_http::cors::{Any, CorsLayer};

pub mod api;

/// Build the Axum router with shared layers.
pub fn app_router() -> Router {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_origin(Any)
        .allow_headers(Any);

    Router::new().nest("/api", api::router()).layer(cors)
}
