# Rust Axum API

Axum-based HTTP service that proxies requests to the TypeScript worker via JSON IPC.

## Prerequisites

- Rust toolchain (1.72 or newer recommended)
- Node.js available on `PATH` (override with `TS_NODE_PATH`)
- Build the TypeScript worker first (`yarn install && yarn build` in `../ts-worker`)
- Copy `../.env.template` to `../.env` and populate RPC/key values as needed

## Running

```bash
cargo run
```

Environment variables:

- `RPC_URL` – forwarded to the TypeScript worker (defaults to Solana devnet)
- `SERVER_PRIVATE_KEY` / `SERVER_KEYPAIR_PATH` – optional worker wallet configuration
- `TS_NODE_PATH` (optional) – path to the Node binary, defaults to `node`
- `TS_WORKER_PATH` (optional) – path to the compiled worker entry point, defaults to `../ts-worker/dist/index.js`

The API listens on `0.0.0.0:8080`.

## Endpoints

- `GET /positions?wallet=<PUBKEY>`
- `GET /positions/details?wallet=<PUBKEY>`
- `GET /balances?wallet=<PUBKEY>`
- `GET /trade-history?wallet=<PUBKEY>`
- `GET /markets/<symbol>`
- `GET /positions/isolated-balance?wallet=<PUBKEY>&market=<SYMBOL>`
- `GET /server/public-key`
- `POST /orders/open-isolated`
- `POST /orders/open-isolated/execute`
- `POST /orders/close`
- `POST /orders/close/execute`
- `POST /margin/transfer`
- `POST /margin/transfer/execute`
- `POST /margin/deposit-native`
- `POST /margin/deposit-native/execute`
- `POST /margin/deposit-token`
- `POST /margin/deposit-token/execute`

All mutation endpoints accept/return JSON exactly as forwarded to/from the TypeScript worker.
