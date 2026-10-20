# Build stage: compile the release binary (SQLite is bundled, so no system library is needed).
FROM rust:1.90-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

# Runtime stage: a small image running as an unprivileged user.
FROM debian:bookworm-slim
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
CMD ["dmaic-studio"]
