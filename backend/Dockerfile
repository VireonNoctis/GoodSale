FROM rust:1.85-slim-bookworm AS builder
WORKDIR /build
COPY backend/Cargo.toml ./Cargo.toml
COPY backend/src ./src
RUN cargo build --release

FROM debian:bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home goodsale
COPY --from=builder /build/target/release/goodsale-api /usr/local/bin/goodsale-api
USER goodsale
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health/ready || exit 1
ENTRYPOINT ["goodsale-api"]
