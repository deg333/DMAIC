//! Administrator endpoints: user management and site-wide settings.

use axum::{
    extract::{FromRequestParts, Path, State},
    http::request::Parts,
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{self, CurrentUser},
    db::{self, new_id, now, row_json, rows_json},
    error::{AppError, AppResult},
    seed, AppState, Config,
};

/// A signed-in user with administrator rights. Everyone else gets 403.
pub struct AdminUser(pub CurrentUser);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        if !user.is_admin {
            return Err(AppError::forbidden("Only administrators can do this."));
        }
        Ok(Self(user))
    }
}

// ---------------------------------------------------------------------------
// Site settings. Values saved by an administrator override the environment defaults.

pub struct SitePolicy {
    pub allow_signup: bool,
    pub signup_code: Option<String>,
    pub sample_project: bool,
}

fn site_value(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM site_settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()?)
}

pub fn site_policy(conn: &Connection, config: &Config) -> AppResult<SitePolicy> {
    Ok(SitePolicy {
        allow_signup: site_value(conn, "allow_signup")?.map(|value| value == "true").unwrap_or(config.allow_signup),
        signup_code: match site_value(conn, "signup_code")? {
            Some(code) => Some(code).filter(|code| !code.is_empty()),
            None => config.signup_code.clone(),
        },
        sample_project: site_value(conn, "sample_project")?.map(|value| value == "true").unwrap_or(true),
    })
}

fn policy_json(policy: &SitePolicy) -> Value {
    json!({
        "allow_signup": policy.allow_signup,
        "signup_code": policy.signup_code.clone().unwrap_or_default(),
        "sample_project": policy.sample_project,
    })
}

pub async fn get_site_settings(State(state): State<AppState>, _admin: AdminUser) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| Ok(Json(policy_json(&site_policy(conn, &state.config)?)))).await
}

#[derive(Deserialize)]
pub struct SiteSettingsInput {
    allow_signup: bool,
    #[serde(default)]
    signup_code: String,
    sample_project: bool,
}

pub async fn put_site_settings(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(input): Json<SiteSettingsInput>,
) -> AppResult<Json<Value>> {
    let signup_code = input.signup_code.trim().to_owned();
    if signup_code.chars().count() > 64 {
        return Err(AppError::bad_request("Sign-up codes must be 64 characters or fewer."));
    }
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        for (key, value) in [
            ("allow_signup", input.allow_signup.to_string()),
            ("signup_code", signup_code),
            ("sample_project", input.sample_project.to_string()),
        ] {
            tx.execute(
                "INSERT INTO site_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(Json(policy_json(&site_policy(conn, &state.config)?)))
    })
    .await
}

// ---------------------------------------------------------------------------
// Users

const USER_SELECT: &str = "SELECT u.id, u.username, u.created_at, u.last_login_at, u.is_admin, u.disabled,
    (SELECT COUNT(*) FROM projects p WHERE p.owner_user_id = u.id) AS project_count
  FROM users u";

pub async fn list_users(State(state): State<AppState>, _admin: AdminUser) -> AppResult<Json<Value>> {
    db::call(&state.db, |conn| {
        Ok(Json(Value::Array(rows_json(conn, &format!("{USER_SELECT} ORDER BY u.username COLLATE NOCASE"), [])?)))
    })
    .await
}

/// Inserts an account; `seed_sample` gives it the example project.
pub fn insert_user(conn: &Connection, username: &str, password_hash: &str, is_admin: bool, seed_sample: bool) -> AppResult<String> {
    let user_id = new_id();
    let inserted = conn.execute(
        "INSERT INTO users (id, username, password_hash, created_at, is_admin) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(username) DO NOTHING",
        params![user_id, username, password_hash, now(), is_admin],
    )?;
    if inserted == 0 {
        return Err(AppError::conflict("That username is already taken."));
    }
    conn.execute(
        "INSERT INTO user_settings (user_id, key, value) VALUES (?1, 'profile-name', ?2)",
        [&user_id, username],
    )?;
    if seed_sample {
        seed::example_project(conn, &user_id)?;
    }
    Ok(user_id)
}

#[derive(Deserialize)]
pub struct NewUser {
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    is_admin: bool,
}

pub async fn create_user(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(input): Json<NewUser>,
) -> AppResult<Json<Value>> {
    let username = auth::validate_username(&input.username)?;
    // Leave the password blank to have one generated and shown once.
    let generated = input.password.is_empty();
    let password = if generated { auth::generate_password() } else { input.password };
    auth::validate_password(&password)?;
    let to_hash = password.clone();
    let password_hash = auth::blocking(move || auth::hash_password(&to_hash)).await??;
    let user = db::call(&state.db, move |conn| {
        let seed_sample = site_policy(conn, &state.config)?.sample_project;
        let tx = conn.transaction()?;
        let user_id = insert_user(&tx, &username, &password_hash, input.is_admin, seed_sample)?;
        tx.commit()?;
        row_json(conn, &format!("{USER_SELECT} WHERE u.id = ?1"), [&user_id])
    })
    .await?;
    Ok(Json(json!({ "user": user, "password": generated.then_some(password) })))
}

/// Number of enabled administrators other than `except_id`.
fn other_active_admins(conn: &Connection, except_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM users WHERE is_admin = 1 AND disabled = 0 AND id <> ?1",
        [except_id],
        |row| row.get(0),
    )?)
}

fn require_user(conn: &Connection, user_id: &str) -> AppResult<(bool, bool)> {
    conn.query_row("SELECT is_admin, disabled FROM users WHERE id = ?1", [user_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?
        .ok_or_else(|| AppError::not_found("This user could not be found."))
}

#[derive(Deserialize)]
pub struct UserChanges {
    is_admin: Option<bool>,
    disabled: Option<bool>,
}

pub async fn update_user(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(user_id): Path<String>,
    Json(changes): Json<UserChanges>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        let (was_admin, was_disabled) = require_user(conn, &user_id)?;
        let is_admin = changes.is_admin.unwrap_or(was_admin);
        let disabled = changes.disabled.unwrap_or(was_disabled);
        if user_id == admin.id && (!is_admin || disabled) {
            return Err(AppError::bad_request("You cannot remove your own administrator access or disable your own account."));
        }
        let loses_admin = was_admin && !was_disabled && (!is_admin || disabled);
        if loses_admin && other_active_admins(conn, &user_id)? == 0 {
            return Err(AppError::bad_request("DMAIC Studio needs at least one active administrator."));
        }
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE users SET is_admin = ?1, disabled = ?2 WHERE id = ?3",
            params![is_admin, disabled, user_id],
        )?;
        if disabled {
            tx.execute("DELETE FROM sessions WHERE user_id = ?1", [&user_id])?;
        }
        tx.commit()?;
        Ok(Json(row_json(conn, &format!("{USER_SELECT} WHERE u.id = ?1"), [&user_id])?.unwrap_or_default()))
    })
    .await
}

pub async fn reset_password(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(user_id): Path<String>,
) -> AppResult<Json<Value>> {
    if user_id == admin.id {
        return Err(AppError::bad_request("Change your own password from Settings → Account."));
    }
    let password = auth::generate_password();
    let to_hash = password.clone();
    let password_hash = auth::blocking(move || auth::hash_password(&to_hash)).await??;
    db::call(&state.db, move |conn| {
        require_user(conn, &user_id)?;
        let tx = conn.transaction()?;
        tx.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", [&password_hash, &user_id])?;
        tx.execute("DELETE FROM sessions WHERE user_id = ?1", [&user_id])?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "password": password })))
}

pub async fn delete_user(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(user_id): Path<String>,
) -> AppResult<Json<Value>> {
    if user_id == admin.id {
        return Err(AppError::bad_request("You cannot delete your own account."));
    }
    db::call(&state.db, move |conn| {
        let (is_admin, disabled) = require_user(conn, &user_id)?;
        if is_admin && !disabled && other_active_admins(conn, &user_id)? == 0 {
            return Err(AppError::bad_request("DMAIC Studio needs at least one active administrator."));
        }
        // Owned projects, memberships, sessions, and settings cascade from users(id).
        conn.execute("DELETE FROM users WHERE id = ?1", [&user_id])?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

// ---------------------------------------------------------------------------
// Startup and recovery

pub fn has_admin(conn: &Connection) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)", [], |row| row.get(0))?)
}

/// For unattended deployments: creates the administrator from `DMAIC_ADMIN_USERNAME` and
/// `DMAIC_ADMIN_PASSWORD` when none exists, and returns whether one was created.
/// Without those variables, the first visitor creates the administrator in the browser.
pub fn ensure_admin(conn: &mut Connection, username: &str, password: &str) -> anyhow::Result<bool> {
    if has_admin(conn).map_err(|_| anyhow::anyhow!("could not check for an administrator"))? {
        return Ok(false);
    }
    let username = auth::validate_username(username).map_err(|_| anyhow::anyhow!("DMAIC_ADMIN_USERNAME is not a valid username"))?;
    let taken: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM users WHERE username = ?1)", [&username], |row| row.get(0))?;
    if taken {
        anyhow::bail!(
            "no administrator exists and the username '{username}' is already used by a regular account; \
             set DMAIC_ADMIN_USERNAME to a different name, or run `dmaic-studio make-admin <username>`"
        );
    }
    auth::validate_password(password).map_err(|_| anyhow::anyhow!("DMAIC_ADMIN_PASSWORD must be at least 8 characters"))?;
    let hash = auth::hash_password(password).map_err(|_| anyhow::anyhow!("could not hash the administrator password"))?;
    let tx = conn.transaction()?;
    insert_user(&tx, &username, &hash, true, false).map_err(|_| anyhow::anyhow!("could not create the administrator account"))?;
    tx.commit()?;
    Ok(true)
}

/// `dmaic-studio reset-password <username>`: sets a new random password and signs the user out everywhere.
pub fn cli_reset_password(conn: &Connection, username: &str) -> anyhow::Result<String> {
    let password = auth::generate_password();
    let hash = auth::hash_password(&password).map_err(|_| anyhow::anyhow!("could not hash the password"))?;
    let user_id: String = conn
        .query_row("SELECT id FROM users WHERE username = ?1", [username], |row| row.get(0))
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("no account named '{username}'"))?;
    conn.execute("UPDATE users SET password_hash = ?1, disabled = 0 WHERE id = ?2", [&hash, &user_id])?;
    conn.execute("DELETE FROM sessions WHERE user_id = ?1", [&user_id])?;
    Ok(password)
}

/// `dmaic-studio make-admin <username>`: grants administrator rights to an existing account.
pub fn cli_make_admin(conn: &Connection, username: &str) -> anyhow::Result<()> {
    let changed = conn.execute("UPDATE users SET is_admin = 1, disabled = 0 WHERE username = ?1", [username])?;
    if changed == 0 {
        anyhow::bail!("no account named '{username}'");
    }
    Ok(())
}
