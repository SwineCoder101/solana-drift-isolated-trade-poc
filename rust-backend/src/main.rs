use axum::{
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::net::SocketAddr;

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    message: String,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        message: "Rust Tokio backend is running".to_string(),
    })
}

#[tokio::main]
async fn main() {
    // Build our application with a route
    let app = Router::new()
        .route("/health", get(health));

    // Run it with hyper on localhost:3001
    let addr = SocketAddr::from(([127, 0, 0, 1], 3001));
    println!("Rust backend listening on {}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
