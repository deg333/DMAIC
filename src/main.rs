mod admin;
mod api;
mod auth;
mod db;
mod error;
mod seed;
mod transfer;

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{DefaultBodyLimit, Request},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Router,
};
use tower_http::services::ServeDir;

use crate::error::AppError;

pub struct Config {
    pub allow_signup: bool,
    pub signup_code: Option<String>,
    pub secure_cookies: bool,
    /// Behind a reverse proxy, take the client address from X-Forwarded-For.
    pub trust_proxy: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub config: Arc<Config>,
    pub limiter: Arc<auth::LoginLimiter>,
}

const MB: usize = 1024 * 1024;

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; \
    img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; \
    form-action 'self'; frame-ancestors 'self'";

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => default,
    }
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| default.to_owned())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();

    let bind: SocketAddr = env_or("DMAIC_BIND", "0.0.0.0:8124").parse()?;
    let db_path = PathBuf::from(env_or("DMAIC_DB", "data/dmaic.sqlite"));
    let web_dir = PathBuf::from(env_or("DMAIC_WEB_DIR", "web"));
    let max_import_mb: usize = env_or("DMAIC_MAX_IMPORT_MB", "256").parse()?;
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Used by Docker's HEALTHCHECK; must not touch the database.
    if args.first().is_some_and(|command| command == "healthcheck") {
        return healthcheck(bind.port());
    }

    let mut conn = db::open(&db_path)?;

    // Maintenance commands, e.g. `dmaic-studio reset-password admin`.
    match args.as_slice() {
        [] => {}
        [command, path] if command == "backup" => {
            // VACUUM INTO writes a consistent copy even while the server is running.
            conn.execute("VACUUM INTO ?1", [path])?;
            println!("Backup written to {path}");
            return Ok(());
        }
        [command, username] if command == "reset-password" => {
            let password = admin::cli_reset_password(&conn, username)?;
            println!("New password for {username}: {password}");
            return Ok(());
        }
        [command, username] if command == "make-admin" => {
            admin::cli_make_admin(&conn, username)?;
            println!("{username} is now an administrator.");
            return Ok(());
        }
        _ => anyhow::bail!(
            "usage: dmaic-studio [reset-password <username> | make-admin <username> | backup <file> | healthcheck]"
        ),
    }

    let admin_username = env_or("DMAIC_ADMIN_USERNAME", "admin");
    let admin_password = std::env::var("DMAIC_ADMIN_PASSWORD").ok().filter(|password| !password.is_empty());
    match admin_password {
        Some(password) => {
            if admin::ensure_admin(&mut conn, &admin_username, &password)? {
                tracing::info!("created administrator account '{admin_username}' from DMAIC_ADMIN_PASSWORD");
            }
        }
        None if !admin::has_admin(&conn).map_err(|_| anyhow::anyhow!("could not check for an administrator"))? => {
            tracing::warn!("no administrator account yet: open the site in a browser to create one");
        }
        None => {}
    }

    if !web_dir.join("index.html").is_file() {
        anyhow::bail!("{} does not contain index.html; set DMAIC_WEB_DIR to the web folder", web_dir.display());
    }

    let config = Config {
        allow_signup: env_flag("DMAIC_ALLOW_SIGNUP", true),
        signup_code: std::env::var("DMAIC_SIGNUP_CODE").ok().map(|code| code.trim().to_owned()).filter(|code| !code.is_empty()),
        secure_cookies: env_flag("DMAIC_SECURE_COOKIES", false),
        trust_proxy: env_flag("DMAIC_TRUST_PROXY", false),
    };
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        config: Arc::new(config),
        limiter: Arc::default(),
    };

    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/auth/status", get(auth::status))
        .route("/auth/register", post(auth::register))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/password", post(auth::change_password))
        .route("/settings", get(api::get_settings).put(api::put_settings))
        .route("/projects", get(api::list_projects).post(api::create_project))
        .route("/projects/{id}", get(api::snapshot).put(api::update_project).delete(api::delete_project))
        .route("/projects/{id}/phase", put(api::set_phase))
        .route("/projects/{id}/members", post(api::add_member))
        .route("/projects/{id}/members/{user_id}", axum::routing::delete(api::remove_member))
        .route("/projects/{id}/entries", post(api::create_entry))
        .route("/projects/{id}/entries/{entry_id}", put(api::update_entry).delete(api::delete_entry))
        .route("/projects/{id}/notes/{phase}/{tab}", put(api::put_note))
        .route("/projects/{id}/process-map", put(api::put_process_map))
        .route("/projects/{id}/charter", put(api::put_charter))
        .route("/projects/{id}/define/{kind}", post(api::create_define))
        .route("/projects/{id}/define/{kind}/{record_id}", put(api::update_define).delete(api::delete_define))
        .route("/projects/{id}/stakeholders/{record_id}/engagement", put(api::set_engagement))
        .route("/projects/{id}/affinity-cards/{record_id}/group", put(api::set_card_group))
        .route("/projects/{id}/affinity/auto-group", post(api::auto_group))
        .route("/projects/{id}/ctq/suggest", post(api::suggest_ctq))
        .route(
            "/projects/{id}/evidence",
            post(api::create_evidence).layer(DefaultBodyLimit::max(api::MAX_EVIDENCE_BYTES + MB)),
        )
        .route(
            "/projects/{id}/evidence/{evidence_id}",
            put(api::update_evidence).layer(DefaultBodyLimit::max(api::MAX_EVIDENCE_BYTES + MB)),
        )
        .route("/projects/{id}/evidence/{evidence_id}/file", get(api::evidence_file))
        .route("/admin/users", get(admin::list_users).post(admin::create_user))
        .route("/admin/users/{user_id}", put(admin::update_user).delete(admin::delete_user))
        .route("/admin/users/{user_id}/reset-password", post(admin::reset_password))
        .route("/admin/settings", get(admin::get_site_settings).put(admin::put_site_settings))
        .route("/export", get(transfer::export))
        .route("/import", post(transfer::import).layer(DefaultBodyLimit::max(max_import_mb * MB)))
        .fallback(|| async { AppError::not_found("Unknown API endpoint.") })
        .layer(DefaultBodyLimit::max(6 * MB))
        .layer(middleware::from_fn(csrf_guard));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new(&web_dir))
        .layer(middleware::from_fn(response_headers))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("DMAIC Studio listening on http://{bind} (database: {})", db_path.display());
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Browsers cannot attach custom headers to cross-site form posts, so requiring
/// one on every state-changing API call blocks CSRF alongside SameSite cookies.
async fn csrf_guard(request: Request, next: Next) -> Response {
    let safe_method = matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe_method && request.headers().get("x-dmaic").is_none_or(|value| value != "1") {
        return AppError::Http(StatusCode::FORBIDDEN, "Request blocked: missing X-DMAIC header.".into()).into_response();
    }
    next.run(request).await
}

async fn response_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.entry(header::X_CONTENT_TYPE_OPTIONS).or_insert(HeaderValue::from_static("nosniff"));
    headers.entry(header::REFERRER_POLICY).or_insert(HeaderValue::from_static("same-origin"));
    headers.entry(header::X_FRAME_OPTIONS).or_insert(HeaderValue::from_static("SAMEORIGIN"));
    let cache = if path.starts_with("/api/") {
        "no-store"
    } else if path.starts_with("/vendor/") {
        "public, max-age=604800"
    } else {
        "no-cache"
    };
    headers.entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static(cache));
    if !path.starts_with("/api/") {
        headers.entry(header::CONTENT_SECURITY_POLICY).or_insert(HeaderValue::from_static(CONTENT_SECURITY_POLICY));
    }
    response
}

/// Exits successfully if the local server answers GET /api/health with 200.
fn healthcheck(port: u16) -> anyhow::Result<()> {
    use std::io::{Read, Write};
    let timeout = std::time::Duration::from_secs(3);
    let mut stream = std::net::TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    if !response.starts_with("HTTP/1.1 200") {
        anyhow::bail!("unhealthy: {}", response.lines().next().unwrap_or("no response"));
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
