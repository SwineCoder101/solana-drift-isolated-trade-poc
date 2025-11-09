# Order Indexing Service

This workspace contains the tooling required to index Drift interactions for the
admin wallet. It is split into a few focused binaries so we can backfill,
stream, and serve trade history concurrently.

## Layout

```
order-indexing-service/
 ├─ indexer-common/    # shared parsing + database helpers
 ├─ indexer-bin/       # realtime streamer (Geyser/logs) + /health HTTP probe
 ├─ backfill-bin/      # historical importer for a given wallet/account
 └─ history-bin/       # lightweight HTTP API for the frontend
```

## Environment

Copy `.env.example` to `.env` and fill in the fields:

```
RPC_URL=https://devnet.helius-rpc.com/?api-key=...
RPC_WS_URL=wss://devnet.helius-rpc.com/?api-key=...
ADMIN_WALLET=<admin pubkey>
DRIFT_PROGRAM_ID=dRifty...
DRIFT_ACCOUNT_ID=<isolated account>
DATABASE_URL=postgres://<user>:<pass>@<host>:5432/<db>
INDEXER_HTTP_PORT=4000
HISTORY_PORT=4010
BACKFILL_LIMIT=500
```

- `RPC_URL`/`RPC_WS_URL` can point at a Geyser-enabled endpoint. The streamer
  uses the websocket feed to listen for Drift program logs in realtime.
- `ADMIN_WALLET` and `DRIFT_ACCOUNT_ID` scope the parser so we only persist the
  admin’s transactions.

## Database schema

Run this migration once inside Supabase/Postgres:

```sql
CREATE TABLE IF NOT EXISTS trade_history (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    asset_symbol TEXT NOT NULL,
    asset_mint TEXT NOT NULL,
    slot BIGINT NOT NULL,
    block_time TIMESTAMPTZ,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Each row represents a unique Solana transaction signature. The parser inspects
token/SOL balance deltas to attach an amount (positive/negative) and the mint or
`SOL` symbol.

## Commands

```bash
# 1) Stream live trades into the DB (auto-reconnects on websocket drops)
cargo run -p indexer-bin

# 2) Backfill historical trades for the admin wallet / Drift account
cargo run -p backfill-bin

# 3) Serve the trade-history API for the frontend
cargo run -p history-bin
```

The history API responds to:

```
GET /history?wallet=<optional>&limit=50&offset=0
```

It returns the most recent trades (defaults to the admin wallet when `wallet`
is omitted) together with the action, signature, asset, and block time.

## Notes

- The streamer writes every inbound request payload/signature to `trade_history`
  via `ON CONFLICT DO NOTHING`, so rerunning a backfill is idempotent.
- To stream directly from a Geyser plugin, point `RPC_WS_URL` to the plugin’s
  websocket/gRPC bridge (e.g. Helius, Triton, or your own solana-geyser setup).
- All binaries share the same `.env` file via `dotenvy`, so running from the
  repo root will automatically pick up the credentials.
