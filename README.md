# solana-drift-isolated-trade-poc

This is a proof of concept for a Solana Drift isolated trade application with three separate components:

## Project Structure

- **frontend/** - Next.js application with TypeScript and Solana wallet adapter
- **rust-backend/** - Rust backend using Tokio and Axum
- **ts-backend/** - NestJS TypeScript backend

## Getting Started

### Frontend (Next.js)

The frontend is a Next.js application with Solana wallet integration.

```bash
cd frontend
npm install
npm run dev
```

The frontend will run on `http://localhost:3000` and includes:
- Solana Web3.js wallet adapter
- Wallet connection button in the Header
- Support for Phantom and Solflare wallets

### Rust Backend (Tokio)

The Rust backend is built with Tokio and Axum for async HTTP handling.

```bash
cd rust-backend
cargo build
cargo run
```

The Rust backend will run on `http://localhost:3001` and provides:
- `/health` endpoint for health checks
- Async runtime with Tokio

### TypeScript Backend (NestJS)

The NestJS backend provides a REST API.

```bash
cd ts-backend
npm install
npm run start:dev
```

The NestJS backend will run on `http://localhost:3000` by default.

## Technologies

- **Frontend**: Next.js 15, React 19, TypeScript, Tailwind CSS, Solana wallet adapter
- **Rust Backend**: Rust, Tokio, Axum, Serde
- **TS Backend**: NestJS, TypeScript

## Development

Each directory contains its own README with specific instructions for that component.

