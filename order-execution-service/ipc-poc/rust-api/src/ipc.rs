use anyhow::Context;
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
	env,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};
use thiserror::Error;
use tokio::{
	io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
	process::{Child, ChildStdin, Command},
	sync::{oneshot, Mutex},
	task::JoinHandle,
};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Debug, Error, Clone)]
pub enum IpcError {
	#[error("ipc timeout")]
	Timeout,
	#[error("worker crashed")]
	WorkerCrashed,
	#[error("ipc protocol error: {0}")]
	Protocol(String),
	#[error("worker returned error: {0}")]
	Remote(String),
	#[error("failed to spawn worker: {0}")]
	Spawn(String),
	#[error("ipc write error: {0}")]
	Write(String),
}

struct Worker {
	child: Child,
	stdin: Arc<Mutex<ChildStdin>>,
	reader: JoinHandle<()>,
}

struct Inner {
	node_path: PathBuf,
	worker_path: PathBuf,
	pending: DashMap<String, oneshot::Sender<Result<Value, IpcError>>>,
	worker: Mutex<Option<Worker>>,
}

#[derive(Deserialize)]
struct WorkerErrorPayload {
	message: String,
}

#[derive(Deserialize)]
struct WorkerResponse {
	id: String,
	ok: bool,
	#[serde(default)]
	result: Option<Value>,
	#[serde(default)]
	error: Option<WorkerErrorPayload>,
}

impl Inner {
	fn new(node_path: PathBuf, worker_path: PathBuf) -> Arc<Self> {
		Arc::new(Self {
			node_path,
			worker_path,
			pending: DashMap::new(),
			worker: Mutex::new(None),
		})
	}

	async fn ensure_worker(self: &Arc<Self>) -> Result<(), IpcError> {
		let mut guard = self.worker.lock().await;
		if guard.is_none() {
			let worker = self.spawn_worker().await?;
			*guard = Some(worker);
		}
		Ok(())
	}

	async fn spawn_worker(self: &Arc<Self>) -> Result<Worker, IpcError> {
		let mut command = Command::new(&self.node_path);
		command
			.arg("--enable-source-maps")
			.arg(&self.worker_path)
			.stdin(std::process::Stdio::piped())
			.stdout(std::process::Stdio::piped())
			.stderr(std::process::Stdio::inherit());

		let mut child = command
			.spawn()
			.map_err(|err| IpcError::Spawn(err.to_string()))?;

		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| IpcError::Spawn("missing stdout".into()))?;
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| IpcError::Spawn("missing stdin".into()))?;

		let inner = Arc::clone(self);
		let reader = tokio::spawn(async move {
			if let Err(err) = inner.read_loop(stdout).await {
				error!(error = %err, "worker reader exited with error");
			}
			inner.handle_worker_failure().await;
		});

		info!(
			worker = %self.worker_path.display(),
			node = %self.node_path.display(),
			"spawned TypeScript worker"
		);

		Ok(Worker {
			child,
			stdin: Arc::new(Mutex::new(stdin)),
			reader,
		})
	}

	async fn read_loop(&self, stdout: tokio::process::ChildStdout) -> anyhow::Result<()> {
		let mut lines = BufReader::new(stdout).lines();

		while let Some(line) = lines.next_line().await? {
			match serde_json::from_str::<WorkerResponse>(&line) {
				Ok(response) => self.dispatch_response(response),
				Err(err) => {
					warn!(line, error = %err, "failed to parse worker response");
				}
			}
		}

		Ok(())
	}

	fn dispatch_response(&self, response: WorkerResponse) {
		if let Some((_, sender)) = self.pending.remove(&response.id) {
			let payload = if response.ok {
				match response.result {
					Some(value) => Ok(value),
					None => Err(IpcError::Protocol(
						"worker returned ok without result".into(),
					)),
				}
			} else {
				let message = response
					.error
					.map(|err| err.message)
					.unwrap_or_else(|| "worker error without message".into());
				Err(IpcError::Remote(message))
			};

			let _ = sender.send(payload);
		} else {
			warn!(id = %response.id, "no pending sender for worker response id");
		}
	}

	async fn handle_worker_failure(self: &Arc<Self>) {
		let mut guard = self.worker.lock().await;
		if let Some(worker) = guard.take() {
			warn!("tearing down crashed worker");
			let _ = worker.child.kill().await;
			worker.reader.abort();
		}
		self.fail_all_pending(IpcError::WorkerCrashed);
	}

	fn fail_all_pending(&self, err: IpcError) {
		let keys: Vec<String> = self.pending.iter().map(|entry| entry.key().clone()).collect();
		for key in keys {
			if let Some((_, sender)) = self.pending.remove(&key) {
				let _ = sender.send(Err(err.clone()));
			}
		}
	}

	async fn call_internal(
		self: &Arc<Self>,
		function: &str,
		args: Value,
		timeout: Duration,
	) -> Result<Value, IpcError> {
		self.ensure_worker().await?;

		let id = Uuid::new_v4().to_string();
		let payload = json!({
			"id": id,
			"fn": function,
			"args": args,
		});
		let serialized =
			serde_json::to_vec(&payload).map_err(|err| IpcError::Protocol(err.to_string()))?;

		let (sender, receiver) = oneshot::channel();
		self.pending.insert(id.clone(), sender);

		let guard = self.worker.lock().await;
		let worker = guard
			.as_ref()
			.ok_or_else(|| IpcError::WorkerCrashed)?;

		{
			let mut stdin = worker.stdin.lock().await;
			if let Err(err) = stdin.write_all(&serialized).await {
				self.pending.remove(&id);
				return Err(IpcError::Write(err.to_string()));
			}
			if let Err(err) = stdin.write_all(b"\n").await {
				self.pending.remove(&id);
				return Err(IpcError::Write(err.to_string()));
			}
			if let Err(err) = stdin.flush().await {
				self.pending.remove(&id);
				return Err(IpcError::Write(err.to_string()));
			}
		}
		drop(guard);

		match tokio::time::timeout(timeout, receiver).await {
			Ok(Ok(Ok(value))) => Ok(value),
			Ok(Ok(Err(err))) => Err(err),
			Ok(Err(_)) => Err(IpcError::WorkerCrashed),
			Err(_) => {
				self.pending.remove(&id);
				Err(IpcError::Timeout)
			}
		}
	}
}

#[derive(Clone)]
pub struct TsIpc {
	inner: Arc<Inner>,
}

impl TsIpc {
	pub async fn connect() -> Result<Self, IpcError> {
		let node_path = env::var("TS_NODE_PATH")
			.map(PathBuf::from)
			.unwrap_or_else(|_| PathBuf::from("node"));

		let default_worker = Path::new("..")
			.join("ts-worker")
			.join("dist")
			.join("index.js");

		let worker_path =
			env::var("TS_WORKER_PATH").map(PathBuf::from).unwrap_or(default_worker);

		let inner = Inner::new(node_path, worker_path);
		inner.ensure_worker().await?;

		Ok(Self { inner })
	}

	pub async fn call(
		&self,
		func: &str,
		args: Value,
		timeout: Duration,
	) -> Result<Value, IpcError> {
		match self
			.inner
			.call_internal(func, args.clone(), timeout)
			.await
		{
			Err(IpcError::WorkerCrashed) | Err(IpcError::Write(_)) => {
				self.inner.handle_worker_failure().await;
				self.inner.ensure_worker().await?;
				self.inner.call_internal(func, args, timeout).await
			}
			result => result,
		}
	}
}

impl Drop for TsIpc {
	fn drop(&mut self) {
		let inner = Arc::clone(&self.inner);
		tokio::spawn(async move {
			let mut guard = inner.worker.lock().await;
			if let Some(worker) = guard.take() {
				let _ = worker.child.kill().await;
				worker.reader.abort();
			}
			inner.fail_all_pending(IpcError::WorkerCrashed);
		});
	}
}
