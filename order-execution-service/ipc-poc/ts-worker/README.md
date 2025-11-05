# TypeScript Worker

This worker wraps `@drift-labs/sdk@2.146.0-alpha.13` and exposes a JSON-over-STDIO interface that the Rust API consumes.

## Setup

```bash
yarn install
yarn build
```

During development you can run:

```bash
yarn dev
```

The compiled entry point is emitted to `dist/index.js` and is expected to be spawned by the Rust API.

Configuration:

- Copy `../../.env.template` to `../../.env` and adjust values.
- Environment variables read by the worker:
  - `RPC_URL` – Solana RPC endpoint (default `https://api.devnet.solana.com`)
  - `SERVER_PRIVATE_KEY` – optional base58/base64/JSON secret key for the worker wallet
  - `SERVER_KEYPAIR_PATH` – optional path to a keypair file (JSON array format)

## IPC Protocol

Requests are newline-delimited JSON objects of the form:

```json
{ "id": "<uuid>", "fn": "openIsolated", "args": { ... } }
```

Responses mirror the request id and return either `result` or `error`:

```json
{ "id": "<uuid>", "ok": true, "result": { ... } }
```

See `src/types.ts` for the full schema.
