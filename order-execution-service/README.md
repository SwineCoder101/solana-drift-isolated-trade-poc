# Order Execution Service PoC

This directory hosts the end-to-end proof-of-concept for isolated perp trades on Solana Drift.

```
order-execution-service/
  ipc-poc/
    ts-worker/   # TypeScript worker (JSON IPC)
    rust-api/    # Axum HTTP API
```

Follow the instructions in `ipc-poc/README.md` to build and run both components.

For configuration values (RPC URLs, optional keypairs), copy `.env.template` to `.env` and populate the secrets before starting either service.
