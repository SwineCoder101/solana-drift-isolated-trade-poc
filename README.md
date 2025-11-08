# solana-drift-isolated-trade-poc
This is a poc for a drift isolated trade, ts nextjs + rust tokio.

## Frontend Environment

Create `frontend/.env.local` with:

```
NEXT_PUBLIC_ORDER_EXECUTION_URL=http://localhost:8080
NEXT_PUBLIC_DRIFT_INDEXER_URL=http://localhost:4000
DB_HOST=localhost
```

Then run the Next.js dev server from `frontend/`.

## Running with Docker

Make sure Docker Desktop (or another engine) is running, then from the repo root:

```bash
docker compose up --build
```

This spins up two services:

- `order-execution-service` – builds the TypeScript worker (fresh `dist/` each time) and starts the Rust Axum API
- `frontend` – Next.js dev server on <http://localhost:3000> pointing at the API (`http://localhost:8080`)

Environment variables such as `RPC_URL` or `SERVER_PRIVATE_KEY` can be provided via a root `.env` file or `docker compose` CLI overrides. Stop everything with `docker compose down`.
