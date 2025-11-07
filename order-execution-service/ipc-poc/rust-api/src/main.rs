mod ipc;
mod routes;
mod types;

use std::net::SocketAddr;

use axum::Router;
use routes::{router, AppState};
use tower::ServiceBuilder;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
 load_env();
 tracing_subscriber::fmt()
		.with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
		.with_target(false)
		.init();

	let ipc = ipc::TsIpc::connect()
		.await
		.map_err(|err| anyhow::anyhow!("failed to spawn worker: {err}"))?;

	let state = AppState { ipc };

	let app: Router = router(state).layer(
		ServiceBuilder::new()
			.layer(TraceLayer::new_for_http())
			.layer(CorsLayer::permissive()),
	);

	let addr: SocketAddr = ([127, 0, 0, 1], 8080).into();
	info!(%addr, "starting Axum API");

	axum::serve(
		tokio::net::TcpListener::bind(addr).await?,
		app.into_make_service(),
	)
	.await?;

	Ok(())
}

fn load_env() {
	let cwd = std::env::current_dir().unwrap_or_default();
	let candidates = [
		cwd.join("..").join("..").join(".env"),
		cwd.join("..").join(".env"),
		cwd.join(".env"),
	];
	for path in candidates {
		if path.exists() {
			let _ = dotenvy::from_path(path);
			return;
		}
	}
	let _ = dotenvy::dotenv();
}
