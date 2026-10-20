use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{rand_core::OsRng, rand_core::RngCore, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts, State},
    http::{header, request::Parts, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    admin,
    db::{self, now},
    error::{AppError, AppResult},
    AppState,
};

const SESSION_COOKIE: &str = "dmaic_session";
const SESSION_DAYS: i64 = 30;
const MAX_LOGIN_FAILURES: u32 = 10;
const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);

/// The signed-in user, resolved from the session cookie. Handlers that take this
/// extractor reject unauthenticated requests with 401.
#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub id: String,
    pub username: String,
    pub is_admin: bool,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = session_token(&parts.headers).ok_or_else(AppError::unauthorized)?;
        db::call(&state.db, move |conn| user_for_token(conn, &token))
            .await?
            .ok_or_else(AppError::unauthorized)
    }
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .find_map(|cookie| cookie.trim().strip_prefix(SESSION_COOKIE)?.strip_prefix('=').map(str::to_owned))
        .filter(|token| token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn user_for_token(conn: &Connection, token: &str) -> AppResult<Option<CurrentUser>> {
    Ok(conn
        .query_row(
            "SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.disabled = 0",
            [hash_token(token), now()],
            |row| Ok(CurrentUser { id: row.get(0)?, username: row.get(1)?, is_admin: row.get(2)? }),
        )
        .optional()?)
}

fn create_session(conn: &Connection, user_id: &str) -> AppResult<String> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", [now()])?;
    conn.execute("UPDATE users SET last_login_at = ?1 WHERE id = ?2", [now(), user_id.to_owned()])?;
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
        [hash_token(&token), user_id.to_owned(), now(), db::timestamp_in_days(SESSION_DAYS)],
    )?;
    Ok(token)
}

fn session_cookie(state: &AppState, token: &str, max_age: i64) -> HeaderValue {
    let secure = if state.config.secure_cookies { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"))
        .expect("session cookie is valid ASCII")
}

fn with_cookie(body: Value, cookie: HeaderValue) -> Response {
    let mut response = Json(body).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    response
}

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| AppError::Internal(anyhow::anyhow!("password hashing failed: {error}")))
}

fn verify_password(password: &str, stored_hash: &str) -> bool {
    PasswordHash::new(stored_hash)
        .map(|hash| Argon2::default().verify_password(password.as_bytes(), &hash).is_ok())
        .unwrap_or(false)
}

/// A real hash to verify against when the username does not exist, so a failed
/// login takes the same time whether or not the account exists.
fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| hash_password("dmaic-timing-equalizer").unwrap_or_default())
}

pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(work).await.map_err(|error| AppError::Internal(error.into()))
}

pub fn validate_username(username: &str) -> AppResult<String> {
    let username = username.trim();
    let valid_chars = username.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'));
    if !(3..=40).contains(&username.chars().count()) || !valid_chars {
        return Err(AppError::bad_request(
            "Usernames must be 3–40 characters using letters, numbers, and . _ - @",
        ));
    }
    Ok(username.to_owned())
}

pub fn validate_password(password: &str) -> AppResult<()> {
    if !(8..=256).contains(&password.chars().count()) {
        return Err(AppError::bad_request("Passwords must be at least 8 characters."));
    }
    Ok(())
}

/// A random 16-character password without look-alike characters, for new or reset accounts.
pub fn generate_password() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut password = String::with_capacity(16);
    while password.len() < 16 {
        let byte = (OsRng.next_u32() & 0xff) as usize;
        // Reject values that would bias the choice toward the start of the alphabet.
        if byte < 256 - 256 % ALPHABET.len() {
            password.push(ALPHABET[byte % ALPHABET.len()] as char);
        }
    }
    password
}

/// In-memory throttle for failed sign-ins, keyed by client address and username.
#[derive(Default)]
pub struct LoginLimiter {
    failures: Mutex<HashMap<String, (u32, Instant)>>,
}

impl LoginLimiter {
    fn is_blocked(&self, key: &str) -> bool {
        let failures = self.failures.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        failures
            .get(key)
            .is_some_and(|(count, since)| *count >= MAX_LOGIN_FAILURES && since.elapsed() < LOGIN_WINDOW)
    }

    fn record_failure(&self, key: &str) {
        let mut failures = self.failures.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if failures.len() > 10_000 {
            failures.retain(|_, (_, since)| since.elapsed() < LOGIN_WINDOW);
        }
        let entry = failures.entry(key.to_owned()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= LOGIN_WINDOW {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
    }

    fn clear(&self, key: &str) {
        self.failures.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(key);
    }
}

pub async fn status(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Value>> {
    let token = session_token(&headers);
    let config = state.config.clone();
    let (user, has_users, has_admin, policy) = db::call(&state.db, move |conn| {
        let user = match token {
            Some(token) => user_for_token(conn, &token)?,
            None => None,
        };
        let has_users: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM users)", [], |row| row.get(0))?;
        Ok((user, has_users, admin::has_admin(conn)?, admin::site_policy(conn, &config)?))
    })
    .await?;
    Ok(Json(json!({
        "authenticated": user.is_some(),
        "user": user.map(|user| json!({ "id": user.id, "username": user.username, "is_admin": user.is_admin })),
        "has_users": has_users,
        "setup_required": !has_admin,
        "signup_allowed": has_admin && policy.allow_signup,
        "signup_code_required": policy.signup_code.is_some(),
    })))
}

#[derive(Deserialize)]
pub struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    signup_code: String,
}

pub async fn register(State(state): State<AppState>, Json(input): Json<Credentials>) -> AppResult<Response> {
    let username = validate_username(&input.username)?;
    validate_password(&input.password)?;
    let config = state.config.clone();
    let (has_admin, policy) =
        db::call(&state.db, move |conn| Ok((admin::has_admin(conn)?, admin::site_policy(conn, &config)?))).await?;
    if !has_admin {
        return Err(AppError::forbidden("This server has not been set up yet. Reload the page to create the administrator account."));
    }
    if !policy.allow_signup {
        return Err(AppError::forbidden("New account sign-up is turned off on this server. Ask your administrator."));
    }
    if let Some(code) = &policy.signup_code {
        if input.signup_code.trim() != code {
            return Err(AppError::forbidden("That sign-up code is not correct."));
        }
    }
    let password = input.password;
    let password_hash = blocking(move || hash_password(&password)).await??;
    let (user_id, token) = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let user_id = admin::insert_user(&tx, &username, &password_hash, false, policy.sample_project)?;
        let token = create_session(&tx, &user_id)?;
        tx.commit()?;
        Ok((user_id, token))
    })
    .await?;
    tracing::info!(user_id, "account created");
    Ok(with_cookie(json!({ "ok": true }), session_cookie(&state, &token, SESSION_DAYS * 86_400)))
}

/// First-run setup: creates the administrator account while none exists, then signs it in.
pub async fn setup(State(state): State<AppState>, Json(input): Json<Credentials>) -> AppResult<Response> {
    let username = validate_username(&input.username)?;
    validate_password(&input.password)?;
    let password = input.password;
    let password_hash = blocking(move || hash_password(&password)).await??;
    let config = state.config.clone();
    let (user_id, token) = db::call(&state.db, move |conn| {
        // The check and insert share one transaction on the single connection, so
        // only the first of two simultaneous setup requests can succeed.
        let tx = conn.transaction()?;
        if admin::has_admin(&tx)? {
            return Err(AppError::conflict("Setup is already complete. Sign in instead."));
        }
        let sample_project = admin::site_policy(&tx, &config)?.sample_project;
        let user_id = admin::insert_user(&tx, &username, &password_hash, true, sample_project)?;
        let token = create_session(&tx, &user_id)?;
        tx.commit()?;
        Ok((user_id, token))
    })
    .await?;
    tracing::info!(user_id, "administrator account created during setup");
    Ok(with_cookie(json!({ "ok": true }), session_cookie(&state, &token, SESSION_DAYS * 86_400)))
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    Json(input): Json<Credentials>,
) -> AppResult<Response> {
    let username = input.username.trim().to_owned();
    let limiter_key = format!("{}|{}", address.ip(), username.to_lowercase());
    if state.limiter.is_blocked(&limiter_key) {
        return Err(AppError::Http(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "Too many failed sign-in attempts. Wait 15 minutes and try again.".into(),
        ));
    }
    let lookup_name = username.clone();
    let account = db::call(&state.db, move |conn| {
        Ok(conn
            .query_row(
                "SELECT id, password_hash, disabled FROM users WHERE username = ?1",
                [&lookup_name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?)),
            )
            .optional()?)
    })
    .await?;
    let password = input.password;
    let (user_id, stored_hash, disabled) = account.clone().unwrap_or_default();
    let verified = blocking(move || {
        let hash = if stored_hash.is_empty() { dummy_hash().to_owned() } else { stored_hash };
        verify_password(&password, &hash)
    })
    .await?;
    if account.is_none() || !verified {
        state.limiter.record_failure(&limiter_key);
        return Err(AppError::Http(axum::http::StatusCode::UNAUTHORIZED, "Incorrect username or password.".into()));
    }
    state.limiter.clear(&limiter_key);
    if disabled {
        return Err(AppError::forbidden("This account has been disabled. Contact your DMAIC Studio administrator."));
    }
    let token = db::call(&state.db, move |conn| create_session(conn, &user_id)).await?;
    Ok(with_cookie(json!({ "ok": true }), session_cookie(&state, &token, SESSION_DAYS * 86_400)))
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    if let Some(token) = session_token(&headers) {
        db::call(&state.db, move |conn| {
            conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [hash_token(&token)])?;
            Ok(())
        })
        .await?;
    }
    Ok(with_cookie(json!({ "ok": true }), session_cookie(&state, "", 0)))
}

#[derive(Deserialize)]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}

pub async fn change_password(
    State(state): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
    Json(input): Json<PasswordChange>,
) -> AppResult<Json<Value>> {
    validate_password(&input.new_password)?;
    let user_id = user.id.clone();
    let stored_hash = db::call(&state.db, move |conn| {
        Ok(conn.query_row("SELECT password_hash FROM users WHERE id = ?1", [&user_id], |row| row.get::<_, String>(0))?)
    })
    .await?;
    let current = input.current_password;
    let new_password = input.new_password;
    let new_hash = blocking(move || {
        if !verify_password(&current, &stored_hash) {
            return Err(AppError::bad_request("Your current password is not correct."));
        }
        hash_password(&new_password)
    })
    .await??;
    let keep_token = session_token(&headers).map(|token| hash_token(&token)).unwrap_or_default();
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        tx.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", [&new_hash, &user.id])?;
        // Sign out every other device that used the old password.
        tx.execute("DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2", [&user.id, &keep_token])?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}
