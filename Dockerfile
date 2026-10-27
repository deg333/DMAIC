# Build stage: compile the release binary (SQLite is bundled, so no system library is needed).
FROM rust:1.90-bookworm AS build
WORKDIR /src
# Build dependencies first with a placeholder main, so this layer stays cached
# until Cargo.toml or Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release --locked && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

# Runtime stage: a small image running as an unprivileged user.
FROM debian:bookworm-slim
# Pick up Debian security fixes released since the base image was published.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --home-dir /app dmaic && mkdir -p /data && chown dmaic /data
WORKDIR /app
COPY --from=build /src/target/release/dmaic-studio /usr/local/bin/dmaic-studio
COPY web ./web
ENV DMAIC_BIND=0.0.0.0:8124 \
    DMAIC_DB=/data/dmaic.sqlite \
    DMAIC_WEB_DIR=/app/web
VOLUME /data
EXPOSE 8124
USER dmaic
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["dmaic-studio", "healthcheck"]
CMD ["dmaic-studio"]
