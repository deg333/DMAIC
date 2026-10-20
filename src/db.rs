use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use chrono::{SecondsFormat, Utc};
use rusqlite::{types::ValueRef, Connection, Params};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

pub type Db = Arc<Mutex<Connection>>;

const SCHEMA_VERSION: i64 = 2;

/// Version 2: administrators, disabled accounts, and site-wide settings.
const MIGRATION_V2: &str = r#"
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_at TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#;

const ACCOUNT_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, problem TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'In progress',
  current_phase TEXT NOT NULL DEFAULT 'define', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
"#;

/// The browser-version schema for exported backups, so files stay importable
/// by this server and readable with any SQLite tool.
pub const EXPORT_DDL: &str = r#"
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, problem TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'In progress',
  current_phase TEXT NOT NULL DEFAULT 'define', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
"#;

/// Tables holding a project's records. Shared by the server schema and exports.
pub const PROJECT_DATA_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS phase_entries (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase TEXT NOT NULL, tab TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Not started',
  due_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS phase_notes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase TEXT NOT NULL, tab TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, PRIMARY KEY (project_id, phase, tab)
);
CREATE TABLE IF NOT EXISTS process_maps (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  xml TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_charters (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  problem TEXT NOT NULL DEFAULT '', business_case TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '', in_scope TEXT NOT NULL DEFAULT '',
  out_scope TEXT NOT NULL DEFAULT '', constraints TEXT NOT NULL DEFAULT '',
  assumptions TEXT NOT NULL DEFAULT '', sponsor TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '',
  budget TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_stakeholders (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', power INTEGER NOT NULL DEFAULT 2,
  interest INTEGER NOT NULL DEFAULT 2, strategy TEXT NOT NULL DEFAULT '',
  engagement TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_communications (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  audience TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_sipoc (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, value TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS define_voc_segments (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_voc_items (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES define_voc_segments(id) ON DELETE SET NULL,
  voice TEXT NOT NULL, issue TEXT NOT NULL DEFAULT '', need TEXT NOT NULL DEFAULT '',
  kano TEXT NOT NULL DEFAULT 'Must-be', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_affinity_groups (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS define_affinity_cards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES define_affinity_groups(id) ON DELETE SET NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_ctq_nodes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES define_ctq_nodes(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS define_risks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  description TEXT NOT NULL, impact INTEGER NOT NULL DEFAULT 3,
  probability INTEGER NOT NULL DEFAULT 3, mitigation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS define_evidence (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '', file_data BLOB, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_project_phase_tab ON phase_entries(project_id, phase, tab);
CREATE INDEX IF NOT EXISTS idx_define_project ON define_stakeholders(project_id);
CREATE INDEX IF NOT EXISTS idx_communications_project ON define_communications(project_id);
CREATE INDEX IF NOT EXISTS idx_sipoc_project ON define_sipoc(project_id);
CREATE INDEX IF NOT EXISTS idx_voc_items_project ON define_voc_items(project_id);
CREATE INDEX IF NOT EXISTS idx_affinity_cards_project ON define_affinity_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_ctq_project ON define_ctq_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_risks_project ON define_risks(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON define_evidence(project_id);
"#;

/// Project tables in an order where every table comes after the tables it references.
pub const PROJECT_TABLES: &[&str] = &[
    "projects",
    "phase_entries",
    "phase_notes",
    "process_maps",
    "define_charters",
    "define_stakeholders",
    "define_communications",
    "define_sipoc",
    "define_voc_segments",
    "define_voc_items",
    "define_affinity_groups",
    "define_affinity_cards",
    "define_ctq_nodes",
    "define_risks",
    "define_evidence",
];

pub fn open(path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        anyhow::bail!("database schema version {version} is newer than this server supports ({SCHEMA_VERSION})");
    }
    // ACCOUNT_DDL is the version 1 schema; later versions are applied as migrations on top.
    let mut batch = format!("BEGIN; {ACCOUNT_DDL} {PROJECT_DATA_DDL}");
    if version < 2 {
        batch.push_str(MIGRATION_V2);
    }
    batch.push_str(&format!("PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"));
    conn.execute_batch(&batch)?;
    Ok(conn)
}

/// Runs blocking database work on the blocking thread pool with the shared connection.
pub async fn call<T, F>(db: &Db, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
{
    let db = db.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        work(&mut conn)
    })
    .await
    .map_err(|error| AppError::Internal(error.into()))?
}

/// Timestamps match the browser's `Date.toISOString()` so they sort as text.
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn timestamp_in_days(days: i64) -> String {
    (Utc::now() + chrono::Duration::days(days)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Returns query results as JSON objects keyed by column name. BLOB columns become null.
pub fn rows_json<P: Params>(conn: &Connection, sql: &str, params: P) -> AppResult<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let columns: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    let rows = statement.query_map(params, |row| {
        let mut object = Map::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                ValueRef::Integer(number) => Value::from(number),
                ValueRef::Real(number) => Value::from(number),
                ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
            };
            object.insert(column.clone(), value);
        }
        Ok(Value::Object(object))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn row_json<P: Params>(conn: &Connection, sql: &str, params: P) -> AppResult<Option<Value>> {
    Ok(rows_json(conn, sql, params)?.into_iter().next())
}

pub fn table_columns(conn: &Connection, schema: &str, table: &str) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(columns.collect::<Result<_, _>>()?)
}
