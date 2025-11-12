use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use axum::Router;
use rust_api::{decoder::DriftDecoder, executor, ipc, routes::{self, AppState}};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceBuilder;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
 load_env();
 let env_filter = EnvFilter::try_from_default_env()
		.unwrap_or_else(|_| EnvFilter::new("info,tower_http=info"));
 tracing_subscriber::fmt()
		.with_env_filter(env_filter)
		.with_target(false)
		.init();

	let ipc = ipc::TsIpc::connect()
		.await
		.map_err(|err| anyhow::anyhow!("failed to spawn worker: {err}"))?;
	let executor = executor::TxExecutor::from_env()
		.map_err(|err| anyhow::anyhow!("executor init failed: {err}"))?;

	let database_url = std::env::var("DATABASE_URL")
		.context("DATABASE_URL not set")?;
	let db = PgPoolOptions::new()
		.max_connections(10)
		.connect(&database_url)
		.await
		.context("failed to connect to database")?;
	sqlx::migrate!()
		.run(&db)
		.await
		.context("failed to run database migrations")?;

	let decoder = Arc::new(DriftDecoder::from_env()?);

	let state = AppState {
		ipc,
		executor: Arc::new(executor),
		db,
		decoder,
	};

	let app: Router = routes::router(state).layer(
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
