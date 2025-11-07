# syntax=docker/dockerfile:1.7

FROM rust:1.86-bookworm AS builder

RUN apt-get update && \
    apt-get install -y curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs build-essential pkg-config libssl-dev && \
    npm install -g yarn && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app/order-execution-service

COPY package.json yarn.lock ./  
COPY ipc-poc ./ipc-poc
COPY scripts ./scripts

RUN yarn install --frozen-lockfile

RUN rm -rf ipc-poc/ts-worker/dist && \
    yarn workspace @ipc-poc/ts-worker build

WORKDIR /app/order-execution-service/ipc-poc/rust-api
RUN cargo build --release

FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app/order-execution-service

COPY --from=builder /app/order-execution-service ./
COPY --from=builder /app/order-execution-service/ipc-poc/rust-api/target/release/rust-api /usr/local/bin/rust-api

ENV TS_NODE_PATH=/usr/bin/node \
    TS_WORKER_PATH=../ts-worker/dist/index.js \
    RPC_URL=https://api.devnet.solana.com

EXPOSE 8080

WORKDIR /app/order-execution-service/ipc-poc/rust-api
ENTRYPOINT ["/usr/local/bin/rust-api"]
