# Test Scripts for Order Execution Service

This directory contains test scripts for all endpoints/functions in the order execution service. All scripts automatically load the `.env` file from `order-execution-service/.env`.

## Prerequisites

- Node.js and npm installed
- `.env` file configured in `order-execution-service/.env` with:
  - `RPC_URL` - Solana RPC endpoint
  - `SERVER_PRIVATE_KEY` or `WALLET_PRIVATE_KEY` - Private key (base58 format)

## Transaction Scripts (Require Signing)

These scripts build and submit transactions to the blockchain.

### `openPosition.ts` - Open an Isolated Position

Opens a new isolated perpetual position.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/openPosition.ts \
  --wallet <WALLET_PUBKEY> \
  --market PERP_SOL \
  --size 0.01 \
  --leverage 5 \
  --margin 0.1
```

**Arguments:**
- `--wallet` (required): Wallet public key
- `--market` (optional, default: `PERP_SOL`): Market symbol
- `--size` (optional, default: `0.1`): Position size
- `--leverage` (optional, default: `5`): Leverage multiplier
- `--margin` (optional, default: `1`): Margin amount

### `closePosition.ts` - Close a Position

Closes an existing position (fully or partially).

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/closePosition.ts \
  --wallet <WALLET_PUBKEY> \
  --market PERP_SOL \
  --size 0.01
```

**Arguments:**
- `--wallet` (required): Wallet public key
- `--market` (optional, default: `PERP_SOL`): Market symbol
- `--size` (optional): Size to close (if omitted, closes full position)

### `transferMargin.ts` - Transfer Margin

Deposits or withdraws margin from an isolated position.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/transferMargin.ts \
  --wallet <WALLET_PUBKEY> \
  --market PERP_SOL \
  --delta 0.5
```

**Arguments:**
- `--wallet` (required): Wallet public key
- `--market` (optional, default: `PERP_SOL`): Market symbol
- `--delta` (required): Amount to transfer (positive = deposit, negative = withdraw)

### `depositNativeSol.ts` - Deposit Native SOL

Deposits native SOL into the spot market.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/depositNativeSol.ts \
  --wallet <WALLET_PUBKEY> \
  --amount 1.0 \
  --market SOL
```

**Arguments:**
- `--wallet` (required): Wallet public key
- `--amount` (required): Amount of SOL to deposit
- `--market` (optional, default: `SOL`): Spot market symbol

### `depositToken.ts` - Deposit Token

Deposits a token (e.g., USDC) into the spot market.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/depositToken.ts \
  --wallet <WALLET_PUBKEY> \
  --amount 100.0 \
  --market USDC
```

**Arguments:**
- `--wallet` (required): Wallet public key
- `--amount` (required): Amount of tokens to deposit
- `--market` (optional, default: `USDC`): Spot market symbol

## Query Scripts (Read-Only)

These scripts query data without submitting transactions.

### `getPositions.ts` - Get All Positions

Retrieves all open positions for a wallet.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/getPositions.ts \
  --wallet <WALLET_PUBKEY>
```

**Arguments:**
- `--wallet` (required): Wallet public key

**Output:** List of all open positions with size, entry price, leverage, and PnL.

### `getPositionDetails.ts` - Get Detailed Position Information

Retrieves detailed information about all open positions, including liquidation price.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/getPositionDetails.ts \
  --wallet <WALLET_PUBKEY>
```

**Arguments:**
- `--wallet` (required): Wallet public key

**Output:** Detailed position information including current price, liquidation price, and more.

### `getMarket.ts` - Get Market Information

Retrieves current market data for a specific market.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/getMarket.ts \
  --symbol PERP_SOL
```

**Arguments:**
- `--symbol` (required): Market symbol (e.g., `PERP_SOL`)

**Output:** Current price, mark price, and funding rate.

### `getIsolatedBalance.ts` - Get Isolated Balance

Retrieves the isolated balance for a specific market.

```bash
cd order-execution-service/ipc-poc/ts-worker && \
npx tsx scripts/getIsolatedBalance.ts \
  --wallet <WALLET_PUBKEY> \
  --market PERP_SOL
```

**Arguments:**
- `--wallet` (required): Wallet public key
- `--market` (required): Market symbol

**Output:** Token amount in the isolated position.

## Examples

### Complete Workflow Example

```bash
# 1. Check current positions
npx tsx scripts/getPositions.ts --wallet 9Bowq8e5ZCPG5ff3oKskg7yz4GRWCJvUJ2GZzPeLv3sg

# 2. Get market info
npx tsx scripts/getMarket.ts --symbol PERP_SOL

# 3. Open a position
npx tsx scripts/openPosition.ts \
  --wallet 9Bowq8e5ZCPG5ff3oKskg7yz4GRWCJvUJ2GZzPeLv3sg \
  --market PERP_SOL \
  --size 0.01 \
  --leverage 5 \
  --margin 0.1

# 4. Check position details
npx tsx scripts/getPositionDetails.ts --wallet 9Bowq8e5ZCPG5ff3oKskg7yz4GRWCJvUJ2GZzPeLv3sg

# 5. Add more margin
npx tsx scripts/transferMargin.ts \
  --wallet 9Bowq8e5ZCPG5ff3oKskg7yz4GRWCJvUJ2GZzPeLv3sg \
  --market PERP_SOL \
  --delta 0.2

# 6. Close the position
npx tsx scripts/closePosition.ts \
  --wallet 9Bowq8e5ZCPG5ff3oKskg7yz4GRWCJvUJ2GZzPeLv3sg \
  --market PERP_SOL
```

## Notes

- All scripts automatically load environment variables from `.env` file
- The private key in `.env` must match the wallet public key provided
- Transaction scripts require sufficient SOL balance for transaction fees
- Read-only scripts don't require signing and are safe to run

