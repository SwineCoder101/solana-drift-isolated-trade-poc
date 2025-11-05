# Solana Drift Isolated Perp PoC

Proof-of-concept that composes a TypeScript worker (wrapping `@drift-labs/sdk`) with a Rust Axum HTTP API connected through JSON-over-STDIO IPC.

```
ipc-poc/
  ts-worker/   # TypeScript worker that builds unsigned transactions via Drift SDK
  rust-api/    # Axum service that exposes HTTP routes and forwards to the worker
```

## Prerequisites

- Node.js 18+
- Yarn
- Rust toolchain (edition 2021)
- `.env` file (copy `../.env.template` and update values)

## Build & Run

```bash
cp ../.env.template ../.env # edit values as needed
cd ts-worker
yarn install
yarn build

cd ../rust-api
cargo run
```

The Rust API listens on `http://0.0.0.0:8080` and launches the worker automatically.

## Test Plan

1. Compile the worker: `cd ts-worker && yarn build`
2. Start the API: `cd ../rust-api && cargo run`
3. Query positions: `curl "http://localhost:8080/positions?wallet=<PUBKEY>"`
4. Build an open order tx:
   ```bash
   curl -X POST http://localhost:8080/orders/open-isolated \
     -H 'content-type: application/json' \
     -d '{ "wallet":"<PUBKEY>", "market":"PERP_SOL", "size":0.1, "leverage":10, "margin":5 }'
   ```
   Expect a JSON payload with `txBase64` and `meta`.
5. Kill the spawned Node process and repeat step 3 to verify automatic restart and retry succeeds.
