//! Backup export and import as standalone SQLite files in the browser-version schema.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Multipart, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OpenFlags};
use serde_json::{json, Value};

use crate::{
    api::validate_setting,
    auth::CurrentUser,
    db::{self, new_id, table_columns, EXPORT_DDL, PROJECT_DATA_DDL, PROJECT_TABLES},
    error::{AppError, AppResult},
    AppState,
};

/// Columns that reference another record, and the table they point to. Imported ids
/// are replaced with fresh ones so a backup can be imported more than once, or by
/// several users, without clashes.
const REFERENCE_COLUMNS: &[(&str, &str)] = &[
    ("project_id", "projects"),
    ("segment_id", "define_voc_segments"),
    ("group_id", "define_affinity_groups"),
    ("parent_id", "define_ctq_nodes"),
];

/// Projects the user owns or has been added to.
const ACCESSIBLE_PROJECTS: &str =
    "SELECT id FROM main.projects WHERE owner_user_id = ?1 UNION SELECT project_id FROM main.project_members WHERE user_id = ?1";

pub async fn export(State(state): State<AppState>, user: CurrentUser) -> AppResult<Response> {
    let bytes = db::call(&state.db, move |conn| {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("export.sqlite");
        {
            let export = Connection::open(&path)?;
            export.execute_batch(&format!("{EXPORT_DDL} {PROJECT_DATA_DDL}"))?;
        }
        conn.execute("ATTACH DATABASE ?1 AS export", [path.to_string_lossy()])?;
        let copied = copy_into_export(conn, &user.id);
        conn.execute("DETACH DATABASE export", [])?;
        copied?;
        Ok(std::fs::read(&path)?)
    })
    .await?;
    let file_name = format!("dmaic-studio-{}.sqlite", chrono::Utc::now().format("%Y-%m-%d"));
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-sqlite3"));
    headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&format!("attachment; filename=\"{file_name}\""))?);
    Ok(response)
}

fn copy_into_export(conn: &mut Connection, user_id: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    for table in PROJECT_TABLES {
        let columns = table_columns(&tx, "export", table)?.join(", ");
        let filter = if *table == "projects" { "id" } else { "project_id" };
        tx.execute(
            &format!(
                "INSERT INTO export.{table} ({columns}) SELECT {columns} FROM main.{table} WHERE {filter} IN ({ACCESSIBLE_PROJECTS})"
            ),
            [user_id],
        )?;
    }
    tx.execute(
        "INSERT INTO export.app_settings (key, value) SELECT key, value FROM main.user_settings WHERE user_id = ?1",
        [user_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub async fn import(State(state): State<AppState>, user: CurrentUser, mut multipart: Multipart) -> AppResult<Json<Value>> {
    let mut upload = None;
    while let Some(field) = multipart.next_field().await.map_err(upload_error)? {
        if field.name() == Some("file") {
            upload = Some(field.bytes().await.map_err(upload_error)?);
        }
    }
    let bytes = upload.ok_or_else(|| AppError::bad_request("Choose a DMAIC Studio .sqlite backup to import."))?;
    if !bytes.starts_with(b"SQLite format 3\0") {
        return Err(AppError::bad_request("This file is not a SQLite database."));
    }
    let imported = db::call(&state.db, move |conn| {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("import.sqlite");
        std::fs::write(&path, &bytes)?;
        let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        source.pragma_update(None, "trusted_schema", false)?;
        import_from(&source, conn, &user.id)
    })
    .await?;
    Ok(Json(json!({ "projects": imported })))
}

fn upload_error(error: axum::extract::multipart::MultipartError) -> AppError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return AppError::Http(StatusCode::PAYLOAD_TOO_LARGE, "This backup is larger than the server accepts.".into());
    }
    AppError::Http(error.status(), format!("The upload could not be read: {}", error.body_text()))
}

fn source_tables(source: &Connection) -> AppResult<HashSet<String>> {
    let mut statement = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let names = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(names.collect::<Result<_, _>>()?)
}

fn import_from(source: &Connection, conn: &mut Connection, user_id: &str) -> AppResult<usize> {
    let tables = source_tables(source)?;
    let project_columns = if tables.contains("projects") { table_columns(source, "main", "projects")? } else { Vec::new() };
    let required = ["id", "name", "problem", "owner", "status", "current_phase"];
    if !required.iter().all(|column| project_columns.iter().any(|c| c == column)) {
        return Err(AppError::bad_request("This file does not contain a compatible DMAIC Studio database."));
    }

    // The ids in each referenced table, so dangling references can be detected.
    let mut known_ids: HashMap<&str, HashSet<String>> = HashMap::new();
    for (_, table) in REFERENCE_COLUMNS {
        let ids = known_ids.entry(table).or_default();
        if tables.contains(*table) {
            let mut statement = source.prepare(&format!("SELECT id FROM \"{table}\""))?;
            for id in statement.query_map([], |row| row.get::<_, Option<String>>(0))? {
                ids.extend(id?);
            }
        }
    }

    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut map_id = |old: &str| id_map.entry(old.to_owned()).or_insert_with(new_id).clone();
    let tx = conn.transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    let mut new_projects = Vec::new();
    let mut stakeholders_need_engagement = false;

    for table in PROJECT_TABLES.iter().filter(|table| tables.contains(**table)) {
        let source_columns = table_columns(source, "main", table)?;
        let columns: Vec<String> = table_columns(&tx, "main", table)?
            .into_iter()
            .filter(|column| column != "owner_user_id" && source_columns.contains(column))
            .collect();
        if *table == "define_stakeholders" && !source_columns.iter().any(|c| c == "engagement") {
            stakeholders_need_engagement = true;
        }
        let select = columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
        let mut insert_columns = columns.clone();
        if *table == "projects" {
            insert_columns.push("owner_user_id".into());
        }
        let placeholders = vec!["?"; insert_columns.len()].join(", ");
        let mut insert = tx.prepare(&format!(
            "INSERT INTO main.{table} ({}) VALUES ({placeholders})",
            insert_columns.join(", ")
        ))?;
        let mut statement = source.prepare(&format!("SELECT {select} FROM \"{table}\""))?;
        let mut rows = statement.query([])?;
        'rows: while let Some(row) = rows.next()? {
            let mut values = Vec::with_capacity(insert_columns.len());
            for (index, column) in columns.iter().enumerate() {
                let mut value: SqlValue = row.get(index)?;
                let referenced = REFERENCE_COLUMNS.iter().find(|(name, _)| name == column).map(|(_, table)| *table);
                if column == "id" {
                    let SqlValue::Text(old) = value else { continue 'rows };
                    value = SqlValue::Text(map_id(&old));
                } else if let Some(referenced) = referenced {
                    value = match value {
                        SqlValue::Text(old) if known_ids[referenced].contains(&old) => SqlValue::Text(map_id(&old)),
                        // A row whose project is missing cannot be imported.
                        _ if column == "project_id" => continue 'rows,
                        // Other dangling links are cleared, keeping the record (a CTQ node becomes a top-level node).
                        _ => SqlValue::Null,
                    };
                }
                values.push(value);
            }
            if *table == "projects" {
                if let Some(SqlValue::Text(id)) = values.first() {
                    new_projects.push(id.clone());
                }
                values.push(SqlValue::Text(user_id.to_owned()));
            }
            insert.execute(params_from_iter(values))?;
        }
    }

    if stakeholders_need_engagement && !new_projects.is_empty() {
        // Older browser backups predate engagement quadrants; place stakeholders from power/interest.
        let project_list = new_projects.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(", ");
        tx.execute(
            &format!(
                "UPDATE define_stakeholders SET engagement = CASE
                   WHEN power >= 3 AND interest >= 3 THEN 'manage' WHEN power >= 3 THEN 'satisfied'
                   WHEN interest >= 3 THEN 'informed' ELSE 'monitor' END
                 WHERE project_id IN ({project_list})"
            ),
            [],
        )?;
    }

    // Bring over profile and preferences from a browser backup without overwriting current ones.
    if tables.contains("app_settings") {
        let mut statement = source.prepare("SELECT key, value FROM app_settings")?;
        let settings = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        for setting in settings {
            let (key, value) = setting?;
            if validate_setting(&key, &value).is_ok() {
                tx.execute(
                    "INSERT OR IGNORE INTO user_settings (user_id, key, value) VALUES (?1, ?2, ?3)",
                    [user_id, &key, &value],
                )?;
            }
        }
    }
    tx.commit()
        .map_err(|_| AppError::bad_request("This backup contains records that reference missing data and could not be imported."))?;
    Ok(new_projects.len())
}
