use axum::{Router, routing::get};

pub mod health;
pub mod order;
pub mod user;

pub use health::HealthResponse;

pub fn router() -> Router {
    Router::new()
        .route("/health", get(health::healthcheck))
        .nest("/orders", order::routes())
        .nest("/users", user::routes())
}
