use axum::{
    extract::{multipart::MultipartError, Multipart, Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{
    auth::CurrentUser,
    db::{self, new_id, now, row_json, rows_json},
    error::{AppError, AppResult},
    AppState,
};

pub const PHASES: &[&str] = &["define", "measure", "analyze", "improve", "control"];
const PROJECT_STATUSES: &[&str] = &["In progress", "On hold", "Completed"];
const ENTRY_STATUSES: &[&str] = &["Not started", "In progress", "Complete", "Blocked"];
const SIPOC_STAGES: &[&str] = &["suppliers", "inputs", "process", "outputs", "customers"];
const KANO_CATEGORIES: &[&str] = &["Must-be", "Performance", "Delighter", "Indifferent"];
const RISK_STATUSES: &[&str] = &["Open", "Mitigating", "Closed"];
const ENGAGEMENTS: &[&str] = &["", "monitor", "satisfied", "informed", "manage"];
const CTQ_TYPES: &[&str] = &["need", "driver", "ctq"];
pub const MAX_EVIDENCE_BYTES: usize = 10 * 1024 * 1024;
const MAX_PROCESS_MAP_BYTES: usize = 5 * 1024 * 1024;
const MAX_NOTE_CHARS: usize = 20_000;
/// Types a browser can display inline without running content from the file.
const INLINE_SAFE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

// ---------------------------------------------------------------------------
// Input helpers. The browser sends form values as strings; numbers are accepted too.

fn raw(body: &Value, key: &str) -> String {
    match body.get(key) {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn text(body: &Value, key: &str, label: &str, max: usize) -> AppResult<String> {
    let value = raw(body, key).trim().to_owned();
    if value.chars().count() > max {
        return Err(AppError::bad_request(format!("{label} must be {max} characters or fewer.")));
    }
    Ok(value)
}

fn required(body: &Value, key: &str, label: &str, max: usize) -> AppResult<String> {
    let value = text(body, key, label, max)?;
    if value.is_empty() {
        return Err(AppError::bad_request(format!("{label} is required.")));
    }
    Ok(value)
}

fn choice(body: &Value, key: &str, label: &str, allowed: &[&str], default: &str) -> AppResult<String> {
    let value = raw(body, key).trim().to_owned();
    if value.is_empty() {
        return Ok(default.to_owned());
    }
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(AppError::bad_request(format!("{label} is not a valid option.")))
    }
}

/// A 1–5 rating such as stakeholder power or risk impact.
fn rating(body: &Value, key: &str, default: i64) -> i64 {
    raw(body, key)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .map(|value| value.round() as i64)
        .unwrap_or(default)
        .clamp(1, 5)
}

fn date(body: &Value, key: &str, label: &str) -> AppResult<String> {
    let value = text(body, key, label, 10)?;
    if value.is_empty() || chrono::NaiveDate::parse_from_str(&value, "%Y-%m-%d").is_ok() {
        Ok(value)
    } else {
        Err(AppError::bad_request(format!("{label} must be a valid date.")))
    }
}

fn valid_tab(tab: &str) -> bool {
    (1..=60).contains(&tab.len()) && tab.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn expect_changed(changed: usize) -> AppResult<()> {
    if changed == 0 {
        Err(AppError::not_found("This item could not be found. It may have been deleted."))
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Project access

struct Access {
    is_owner: bool,
}

/// Owners and members may read and edit a project. Everyone else gets a 404 so
/// project IDs cannot be probed.
fn access(conn: &Connection, user: &CurrentUser, project_id: &str) -> AppResult<Access> {
    let owner: Option<String> = conn
        .query_row("SELECT owner_user_id FROM projects WHERE id = ?1", [project_id], |row| row.get(0))
        .optional()?;
    let Some(owner) = owner else {
        return Err(AppError::not_found("This project could not be found."));
    };
    if owner == user.id {
        return Ok(Access { is_owner: true });
    }
    let member: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM project_members WHERE project_id = ?1 AND user_id = ?2)",
        [project_id, &user.id],
        |row| row.get(0),
    )?;
    if member {
        Ok(Access { is_owner: false })
    } else {
        Err(AppError::not_found("This project could not be found."))
    }
}

fn touch(conn: &Connection, project_id: &str) -> AppResult<()> {
    conn.execute("UPDATE projects SET updated_at = ?1 WHERE id = ?2", [now(), project_id.to_owned()])?;
    Ok(())
}

const PROJECT_SELECT: &str = "SELECT p.id, p.name, p.problem, p.owner, p.status, p.current_phase, p.created_at, p.updated_at,
    u.username AS owner_username, (p.owner_user_id = ?1) AS is_owner,
    (SELECT COUNT(*) FROM phase_entries e WHERE e.project_id = p.id) AS entry_count,
    (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count
  FROM projects p JOIN users u ON u.id = p.owner_user_id";

fn members(conn: &Connection, project_id: &str) -> AppResult<Vec<Value>> {
    rows_json(
        conn,
        "SELECT u.id, u.username, m.added_at FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ?1 ORDER BY u.username",
        [project_id],
    )
}

// ---------------------------------------------------------------------------
// Projects

pub async fn list_projects(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        let projects = rows_json(
            conn,
            &format!(
                "{PROJECT_SELECT}
                 WHERE p.owner_user_id = ?1
                    OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?1)
                 ORDER BY p.updated_at DESC"
            ),
            [&user.id],
        )?;
        Ok(Json(Value::Array(projects)))
    })
    .await
}

struct ProjectFields {
    name: String,
    problem: String,
    owner: String,
    status: String,
}

fn project_fields(body: &Value) -> AppResult<ProjectFields> {
    Ok(ProjectFields {
        name: required(body, "name", "Project name", 120)?,
        problem: text(body, "problem", "Problem statement", 1000)?,
        owner: text(body, "owner", "Project owner", 100)?,
        status: choice(body, "status", "Status", PROJECT_STATUSES, "In progress")?,
    })
}

pub async fn create_project(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let fields = project_fields(&body)?;
    db::call(&state.db, move |conn| {
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO projects (id, owner_user_id, name, problem, owner, status, current_phase, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'define', ?7, ?7)",
            params![id, user.id, fields.name, fields.problem, fields.owner, fields.status, now],
        )?;
        Ok(Json(json!({ "id": id })))
    })
    .await
}

pub async fn update_project(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let fields = project_fields(&body)?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        conn.execute(
            "UPDATE projects SET name = ?1, problem = ?2, owner = ?3, status = ?4, updated_at = ?5 WHERE id = ?6",
            params![fields.name, fields.problem, fields.owner, fields.status, now(), project_id],
        )?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

pub async fn delete_project(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        if !access(conn, &user, &project_id)?.is_owner {
            return Err(AppError::forbidden("Only the project owner can delete this project."));
        }
        // Every project table cascades from projects(id).
        conn.execute("DELETE FROM projects WHERE id = ?1", [&project_id])?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

pub async fn set_phase(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let phase = choice(&body, "phase", "Phase", PHASES, "define")?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        conn.execute(
            "UPDATE projects SET current_phase = ?1, updated_at = ?2 WHERE id = ?3",
            params![phase, now(), project_id],
        )?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

/// Everything the UI needs to render one project, except evidence file contents.
pub async fn snapshot(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let id = project_id.as_str();
        let project = row_json(conn, &format!("{PROJECT_SELECT} WHERE p.id = ?2"), [user.id.as_str(), id])?;
        let process_map: Option<String> = conn
            .query_row("SELECT xml FROM process_maps WHERE project_id = ?1", [id], |row| row.get(0))
            .optional()?;
        Ok(Json(json!({
            "project": project,
            "members": members(conn, id)?,
            "entries": rows_json(conn, "SELECT * FROM phase_entries WHERE project_id = ?1 ORDER BY created_at DESC", [id])?,
            "notes": rows_json(conn, "SELECT phase, tab, note FROM phase_notes WHERE project_id = ?1", [id])?,
            "process_map": process_map,
            "charter": row_json(conn, "SELECT * FROM define_charters WHERE project_id = ?1", [id])?,
            "stakeholders": rows_json(conn, "SELECT * FROM define_stakeholders WHERE project_id = ?1 ORDER BY name", [id])?,
            "communications": rows_json(conn, "SELECT * FROM define_communications WHERE project_id = ?1 ORDER BY audience", [id])?,
            "sipoc": rows_json(conn, "SELECT * FROM define_sipoc WHERE project_id = ?1 ORDER BY sort_order, value", [id])?,
            "voc_segments": rows_json(conn, "SELECT * FROM define_voc_segments WHERE project_id = ?1 ORDER BY name", [id])?,
            "voc_items": rows_json(
                conn,
                "SELECT v.*, s.name AS segment_name FROM define_voc_items v
                 LEFT JOIN define_voc_segments s ON s.id = v.segment_id
                 WHERE v.project_id = ?1 ORDER BY v.created_at",
                [id],
            )?,
            "affinity_groups": rows_json(conn, "SELECT * FROM define_affinity_groups WHERE project_id = ?1 ORDER BY sort_order, name", [id])?,
            "affinity_cards": rows_json(conn, "SELECT * FROM define_affinity_cards WHERE project_id = ?1 ORDER BY created_at", [id])?,
            "ctq_nodes": rows_json(conn, "SELECT * FROM define_ctq_nodes WHERE project_id = ?1 ORDER BY sort_order, title", [id])?,
            "risks": rows_json(conn, "SELECT * FROM define_risks WHERE project_id = ?1 ORDER BY impact * probability DESC", [id])?,
            "evidence": rows_json(
                conn,
                "SELECT id, title, detail, file_name, mime_type, created_at, (file_data IS NOT NULL) AS has_file
                 FROM define_evidence WHERE project_id = ?1 ORDER BY created_at DESC",
                [id],
            )?,
        })))
    })
    .await
}

// ---------------------------------------------------------------------------
// Sharing

pub async fn add_member(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let username = required(&body, "username", "Username", 40)?;
    db::call(&state.db, move |conn| {
        if !access(conn, &user, &project_id)?.is_owner {
            return Err(AppError::forbidden("Only the project owner can share this project."));
        }
        let member_id: Option<String> = conn
            .query_row("SELECT id FROM users WHERE username = ?1", [&username], |row| row.get(0))
            .optional()?;
        let Some(member_id) = member_id else {
            return Err(AppError::not_found("No account with that username exists."));
        };
        if member_id == user.id {
            return Err(AppError::bad_request("You already own this project."));
        }
        conn.execute(
            "INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?1, ?2, ?3)",
            params![project_id, member_id, now()],
        )?;
        Ok(Json(Value::Array(members(conn, &project_id)?)))
    })
    .await
}

pub async fn remove_member(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, member_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        let is_owner = access(conn, &user, &project_id)?.is_owner;
        if !is_owner && member_id != user.id {
            return Err(AppError::forbidden("Only the project owner can remove team members."));
        }
        conn.execute(
            "DELETE FROM project_members WHERE project_id = ?1 AND user_id = ?2",
            [&project_id, &member_id],
        )?;
        Ok(Json(Value::Array(members(conn, &project_id)?)))
    })
    .await
}

// ---------------------------------------------------------------------------
// Phase work items, notes, and process maps

struct EntryFields {
    title: String,
    detail: String,
    owner: String,
    status: String,
    due_date: String,
}

fn entry_fields(body: &Value) -> AppResult<EntryFields> {
    Ok(EntryFields {
        title: required(body, "title", "Title", 180)?,
        detail: text(body, "detail", "Details", 1600)?,
        owner: text(body, "owner", "Owner", 100)?,
        status: choice(body, "status", "Status", ENTRY_STATUSES, "Not started")?,
        due_date: date(body, "due_date", "Target date")?,
    })
}

pub async fn create_entry(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let phase = choice(&body, "phase", "Phase", PHASES, "")?;
    let tab = raw(&body, "tab");
    if phase.is_empty() || !valid_tab(&tab) {
        return Err(AppError::bad_request("Choose a phase and tab for this work item."));
    }
    let fields = entry_fields(&body)?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO phase_entries (id, project_id, phase, tab, title, detail, owner, status, due_date, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![id, project_id, phase, tab, fields.title, fields.detail, fields.owner, fields.status, fields.due_date, now],
        )?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "id": id })))
    })
    .await
}

pub async fn update_entry(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, entry_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let fields = entry_fields(&body)?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        expect_changed(conn.execute(
            "UPDATE phase_entries SET title = ?1, detail = ?2, owner = ?3, status = ?4, due_date = ?5, updated_at = ?6
             WHERE id = ?7 AND project_id = ?8",
            params![fields.title, fields.detail, fields.owner, fields.status, fields.due_date, now(), entry_id, project_id],
        )?)?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

pub async fn delete_entry(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, entry_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        conn.execute("DELETE FROM phase_entries WHERE id = ?1 AND project_id = ?2", [&entry_id, &project_id])?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

pub async fn put_note(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, phase, tab)): Path<(String, String, String)>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    if !PHASES.contains(&phase.as_str()) || !valid_tab(&tab) {
        return Err(AppError::bad_request("Unknown phase or tab."));
    }
    let note = raw(&body, "note");
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(AppError::bad_request(format!("Notes must be {MAX_NOTE_CHARS} characters or fewer.")));
    }
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        conn.execute(
            "INSERT INTO phase_notes (project_id, phase, tab, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_id, phase, tab) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
            params![project_id, phase, tab, note, now()],
        )?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

pub async fn put_process_map(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let xml = raw(&body, "xml");
    if xml.trim().is_empty() {
        return Err(AppError::bad_request("The process map is empty."));
    }
    if xml.len() > MAX_PROCESS_MAP_BYTES {
        return Err(AppError::bad_request("Process maps must be 5 MB or smaller."));
    }
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let now = now();
        conn.execute(
            "INSERT INTO process_maps (project_id, xml, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id) DO UPDATE SET xml = excluded.xml, updated_at = excluded.updated_at",
            params![project_id, xml, now],
        )?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

// ---------------------------------------------------------------------------
// Define phase

const CHARTER_FIELDS: &[(&str, &str, usize)] = &[
    ("problem", "Problem statement", 2000),
    ("business_case", "Business case", 2000),
    ("goal", "Goal statement", 2000),
    ("in_scope", "In scope", 2000),
    ("out_scope", "Out of scope", 2000),
    ("constraints", "Constraints", 2000),
    ("assumptions", "Assumptions", 2000),
    ("sponsor", "Sponsor", 240),
    ("start_date", "Start date", 10),
    ("end_date", "End date", 10),
    ("budget", "Budget", 240),
];

pub async fn put_charter(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let mut values = Vec::with_capacity(CHARTER_FIELDS.len());
    for (key, label, max) in CHARTER_FIELDS {
        values.push(match *key {
            "problem" => required(&body, key, label, *max)?,
            "start_date" | "end_date" => date(&body, key, label)?,
            _ => text(&body, key, label, *max)?,
        });
    }
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let now = now();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO define_charters (project_id, problem, business_case, goal, in_scope, out_scope, constraints,
               assumptions, sponsor, start_date, end_date, budget, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(project_id) DO UPDATE SET problem = excluded.problem, business_case = excluded.business_case,
               goal = excluded.goal, in_scope = excluded.in_scope, out_scope = excluded.out_scope,
               constraints = excluded.constraints, assumptions = excluded.assumptions, sponsor = excluded.sponsor,
               start_date = excluded.start_date, end_date = excluded.end_date, budget = excluded.budget,
               updated_at = excluded.updated_at",
            params![
                project_id, values[0], values[1], values[2], values[3], values[4], values[5],
                values[6], values[7], values[8], values[9], values[10], now
            ],
        )?;
        // Keep the project card in step with the charter's problem and sponsor.
        tx.execute(
            "UPDATE projects SET problem = CASE WHEN ?1 = '' THEN problem ELSE ?1 END,
               owner = CASE WHEN ?2 = '' THEN owner ELSE ?2 END, updated_at = ?3 WHERE id = ?4",
            params![values[0], values[7], now, project_id],
        )?;
        tx.commit()?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

fn define_table(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "stakeholder" => "define_stakeholders",
        "communication" => "define_communications",
        "sipoc" => "define_sipoc",
        "voc-segment" => "define_voc_segments",
        "voc-item" => "define_voc_items",
        "affinity-group" => "define_affinity_groups",
        "affinity-card" => "define_affinity_cards",
        "ctq" => "define_ctq_nodes",
        "risk" => "define_risks",
        "evidence" => "define_evidence",
        _ => return None,
    })
}

fn next_sort_order(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> AppResult<i64> {
    Ok(conn.query_row(sql, params, |row| row.get(0))?)
}

/// Creates (`id == None`) or updates a Define record and returns its id.
fn save_define(conn: &Connection, project_id: &str, kind: &str, id: Option<&str>, body: &Value) -> AppResult<String> {
    let now = now();
    let new_record_id = new_id();
    match kind {
        "stakeholder" => {
            let name = required(body, "name", "Stakeholder name", 240)?;
            let role = text(body, "role", "Role", 240)?;
            let power = rating(body, "power", 3);
            let interest = rating(body, "interest", 3);
            let strategy = text(body, "strategy", "Engagement strategy", 2000)?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_stakeholders SET name = ?1, role = ?2, power = ?3, interest = ?4, strategy = ?5
                     WHERE id = ?6 AND project_id = ?7",
                    params![name, role, power, interest, strategy, id, project_id],
                )?)?,
                None => {
                    conn.execute(
                        "INSERT INTO define_stakeholders (id, project_id, name, role, power, interest, strategy, engagement, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8)",
                        params![new_record_id, project_id, name, role, power, interest, strategy, now],
                    )?;
                }
            }
        }
        "communication" => {
            let audience = required(body, "audience", "Audience", 240)?;
            let purpose = text(body, "purpose", "Purpose", 2000)?;
            let channel = text(body, "channel", "Channel", 240)?;
            let cadence = text(body, "cadence", "Cadence", 240)?;
            let owner = text(body, "owner", "Owner", 240)?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_communications SET audience = ?1, purpose = ?2, channel = ?3, cadence = ?4, owner = ?5
                     WHERE id = ?6 AND project_id = ?7",
                    params![audience, purpose, channel, cadence, owner, id, project_id],
                )?)?,
                None => {
                    conn.execute(
                        "INSERT INTO define_communications (id, project_id, audience, purpose, channel, cadence, owner, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![new_record_id, project_id, audience, purpose, channel, cadence, owner, now],
                    )?;
                }
            }
        }
        "sipoc" => {
            let value = required(body, "value", "SIPOC element", 240)?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_sipoc SET value = ?1 WHERE id = ?2 AND project_id = ?3",
                    params![value, id, project_id],
                )?)?,
                None => {
                    let stage = choice(body, "stage", "SIPOC stage", SIPOC_STAGES, "process")?;
                    let sort = next_sort_order(
                        conn,
                        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM define_sipoc WHERE project_id = ?1 AND stage = ?2",
                        [project_id, stage.as_str()],
                    )?;
                    conn.execute(
                        "INSERT INTO define_sipoc (id, project_id, stage, value, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![new_record_id, project_id, stage, value, sort],
                    )?;
                }
            }
        }
        "voc-segment" => {
            let name = required(body, "name", "Customer segment", 240)?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_voc_segments SET name = ?1 WHERE id = ?2 AND project_id = ?3",
                    params![name, id, project_id],
                )?)?,
                None => {
                    conn.execute(
                        "INSERT INTO define_voc_segments (id, project_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
                        params![new_record_id, project_id, name, now],
                    )?;
                }
            }
        }
        "voc-item" => {
            let segment_id = raw(body, "segment_id").trim().to_owned();
            let segment_id = if segment_id.is_empty() {
                None
            } else {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS (SELECT 1 FROM define_voc_segments WHERE id = ?1 AND project_id = ?2)",
                    [segment_id.as_str(), project_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(AppError::bad_request("That customer segment no longer exists."));
                }
                Some(segment_id)
            };
            let voice = required(body, "voice", "Verbatim voice", 2000)?;
            let issue = text(body, "issue", "Key issue", 2000)?;
            let need = text(body, "need", "Critical customer need", 2000)?;
            let kano = choice(body, "kano", "Kano category", KANO_CATEGORIES, "Must-be")?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_voc_items SET segment_id = ?1, voice = ?2, issue = ?3, need = ?4, kano = ?5
                     WHERE id = ?6 AND project_id = ?7",
                    params![segment_id, voice, issue, need, kano, id, project_id],
                )?)?,
                None => {
                    conn.execute(
                        "INSERT INTO define_voc_items (id, project_id, segment_id, voice, issue, need, kano, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![new_record_id, project_id, segment_id, voice, issue, need, kano, now],
                    )?;
                }
            }
        }
        "affinity-group" => {
            let name = required(body, "name", "Theme name", 240)?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_affinity_groups SET name = ?1 WHERE id = ?2 AND project_id = ?3",
                    params![name, id, project_id],
                )?)?,
                None => {
                    let sort = next_sort_order(
                        conn,
                        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM define_affinity_groups WHERE project_id = ?1",
                        [project_id],
                    )?;
                    conn.execute(
                        "INSERT INTO define_affinity_groups (id, project_id, name, sort_order) VALUES (?1, ?2, ?3, ?4)",
                        params![new_record_id, project_id, name, sort],
                    )?;
                }
            }
        }
        "affinity-card" => {
            let card_text = required(body, "text", "Idea", 2000)?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_affinity_cards SET text = ?1 WHERE id = ?2 AND project_id = ?3",
                    params![card_text, id, project_id],
                )?)?,
                None => {
                    conn.execute(
                        "INSERT INTO define_affinity_cards (id, project_id, text, created_at) VALUES (?1, ?2, ?3, ?4)",
                        params![new_record_id, project_id, card_text, now],
                    )?;
                }
            }
        }
        "ctq" => {
            let title = required(body, "title", "CTQ item", 240)?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_ctq_nodes SET title = ?1 WHERE id = ?2 AND project_id = ?3",
                    params![title, id, project_id],
                )?)?,
                None => {
                    let parent_id = raw(body, "parent_id").trim().to_owned();
                    let mut node_type = choice(body, "node_type", "Tree level", CTQ_TYPES, "need")?;
                    let parent_id = if parent_id.is_empty() {
                        None
                    } else {
                        let parent_type: Option<String> = conn
                            .query_row(
                                "SELECT node_type FROM define_ctq_nodes WHERE id = ?1 AND project_id = ?2",
                                [parent_id.as_str(), project_id],
                                |row| row.get(0),
                            )
                            .optional()?;
                        node_type = match parent_type.as_deref() {
                            None => return Err(AppError::bad_request("The selected parent node no longer exists.")),
                            Some("ctq") => return Err(AppError::bad_request("CTQ measures cannot have child nodes.")),
                            Some("need") => "driver".into(),
                            Some(_) => "ctq".into(),
                        };
                        Some(parent_id)
                    };
                    conn.execute(
                        "INSERT INTO define_ctq_nodes (id, project_id, parent_id, node_type, title) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![new_record_id, project_id, parent_id, node_type, title],
                    )?;
                }
            }
        }
        "risk" => {
            let description = required(body, "description", "Risk description", 2000)?;
            let impact = rating(body, "impact", 3);
            let probability = rating(body, "probability", 3);
            let mitigation = text(body, "mitigation", "Mitigation", 2000)?;
            let status = choice(body, "status", "Status", RISK_STATUSES, "Open")?;
            match id {
                Some(id) => expect_changed(conn.execute(
                    "UPDATE define_risks SET description = ?1, impact = ?2, probability = ?3, mitigation = ?4, status = ?5
                     WHERE id = ?6 AND project_id = ?7",
                    params![description, impact, probability, mitigation, status, id, project_id],
                )?)?,
                None => {
                    conn.execute(
                        "INSERT INTO define_risks (id, project_id, description, impact, probability, mitigation, status, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![new_record_id, project_id, description, impact, probability, mitigation, status, now],
                    )?;
                }
            }
        }
        _ => return Err(AppError::bad_request("This Define record type is not supported.")),
    }
    Ok(id.map(str::to_owned).unwrap_or(new_record_id))
}

pub async fn create_define(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, kind)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let id = save_define(conn, &project_id, &kind, None, &body)?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "id": id })))
    })
    .await
}

pub async fn update_define(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, kind, record_id)): Path<(String, String, String)>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        save_define(conn, &project_id, &kind, Some(&record_id), &body)?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "id": record_id })))
    })
    .await
}

pub async fn delete_define(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, kind, record_id)): Path<(String, String, String)>,
) -> AppResult<Json<Value>> {
    let table = define_table(&kind).ok_or_else(|| AppError::bad_request("This Define item cannot be deleted."))?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        // Foreign keys remove CTQ child nodes and unlink affinity cards and VOC items.
        conn.execute(&format!("DELETE FROM {table} WHERE id = ?1 AND project_id = ?2"), [&record_id, &project_id])?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

pub async fn set_engagement(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, stakeholder_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let engagement = choice(&body, "engagement", "Engagement", ENGAGEMENTS, "")?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        // Moving into a quadrant also nudges power/interest to match it.
        expect_changed(conn.execute(
            "UPDATE define_stakeholders SET engagement = ?1,
               power = CASE WHEN ?1 = '' THEN power WHEN ?1 IN ('satisfied', 'manage') THEN MAX(power, 3) ELSE MIN(power, 2) END,
               interest = CASE WHEN ?1 = '' THEN interest WHEN ?1 IN ('informed', 'manage') THEN MAX(interest, 3) ELSE MIN(interest, 2) END
             WHERE id = ?2 AND project_id = ?3",
            params![engagement, stakeholder_id, project_id],
        )?)?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

pub async fn set_card_group(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, card_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let group_id = raw(&body, "group_id").trim().to_owned();
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let group_id = if group_id.is_empty() {
            None
        } else {
            let exists: bool = conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM define_affinity_groups WHERE id = ?1 AND project_id = ?2)",
                [&group_id, &project_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(AppError::bad_request("That theme no longer exists."));
            }
            Some(group_id)
        };
        expect_changed(conn.execute(
            "UPDATE define_affinity_cards SET group_id = ?1 WHERE id = ?2 AND project_id = ?3",
            params![group_id, card_id, project_id],
        )?)?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

const AFFINITY_BUCKETS: &[(&str, &[&str])] = &[
    ("People & skills", &["operator", "people", "training", "skill", "staff", "shift", "experience", "communication", "supervisor"]),
    ("Process & methods", &["process", "method", "standard", "procedure", "setup", "sequence", "workflow", "changeover", "instruction"]),
    ("Equipment & tools", &["machine", "equipment", "tool", "mold", "mould", "press", "sensor", "maintenance", "fixture", "gage", "gauge"]),
    ("Materials & inputs", &["material", "resin", "pellet", "supplier", "moisture", "batch", "raw", "lot", "input"]),
    ("Measurement & data", &["measure", "data", "record", "inspection", "check", "sampling", "quality", "scrap", "defect", "rate", "weight"]),
    ("Environment", &["environment", "temperature", "humidity", "water", "air", "cooling", "room", "noise", "cleanliness"]),
];

/// Picks the first theme with a keyword appearing as a whole word in the idea.
fn affinity_bucket(idea: &str) -> Option<&'static str> {
    let words: Vec<String> = idea
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    AFFINITY_BUCKETS
        .iter()
        .find(|(_, keywords)| words.iter().any(|word| keywords.contains(&word.as_str())))
        .map(|(name, _)| *name)
}

pub async fn auto_group(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let tx = conn.transaction()?;
        let cards: Vec<(String, String)> = {
            let mut statement = tx.prepare(
                "SELECT id, text FROM define_affinity_cards WHERE project_id = ?1 AND group_id IS NULL ORDER BY created_at",
            )?;
            let rows = statement.query_map([&project_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut group_ids: std::collections::HashMap<String, String> = {
            let mut statement = tx.prepare("SELECT id, name FROM define_affinity_groups WHERE project_id = ?1")?;
            let rows = statement.query_map([&project_id], |row| {
                Ok((row.get::<_, String>(1)?.to_lowercase(), row.get::<_, String>(0)?))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let mut grouped = 0;
        for (card_id, card_text) in &cards {
            let Some(bucket) = affinity_bucket(card_text) else { continue };
            let key = bucket.to_lowercase();
            if !group_ids.contains_key(&key) {
                let group_id = new_id();
                tx.execute(
                    "INSERT INTO define_affinity_groups (id, project_id, name, sort_order) VALUES (?1, ?2, ?3, ?4)",
                    params![group_id, project_id, bucket, 100 + group_ids.len() as i64],
                )?;
                group_ids.insert(key.clone(), group_id);
            }
            tx.execute(
                "UPDATE define_affinity_cards SET group_id = ?1 WHERE id = ?2 AND project_id = ?3",
                params![group_ids[&key], card_id, project_id],
            )?;
            grouped += 1;
        }
        touch(&tx, &project_id)?;
        tx.commit()?;
        Ok(Json(json!({ "grouped": grouped, "total": cards.len() })))
    })
    .await
}

pub async fn suggest_ctq(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let tx = conn.transaction()?;
        let ideas: Vec<(String, String, String)> = {
            let mut statement = tx.prepare(
                "SELECT need, issue, voice FROM define_voc_items WHERE project_id = ?1 ORDER BY created_at",
            )?;
            let rows = statement.query_map([&project_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let goal: Option<String> = tx
            .query_row("SELECT goal FROM define_charters WHERE project_id = ?1", [&project_id], |row| row.get(0))
            .optional()?;
        let suggestions: Vec<(String, String)> = if !ideas.is_empty() {
            ideas
                .into_iter()
                .map(|(need, issue, voice)| {
                    let need = if need.is_empty() { voice } else { need };
                    let driver = if issue.is_empty() { format!("Measure performance for: {need}") } else { issue };
                    (need, driver)
                })
                .collect()
        } else {
            goal.filter(|goal| !goal.is_empty())
                .map(|goal| vec![(goal, "Define measurable customer requirements".to_owned())])
                .unwrap_or_default()
        };
        if suggestions.is_empty() {
            return Err(AppError::bad_request("Add a VOC item or charter goal before generating a CTQ outline."));
        }
        for (index, (need, driver)) in suggestions.iter().enumerate() {
            let need_id = new_id();
            let driver_id = new_id();
            tx.execute(
                "INSERT INTO define_ctq_nodes (id, project_id, parent_id, node_type, title, sort_order) VALUES (?1, ?2, NULL, 'need', ?3, ?4)",
                params![need_id, project_id, need, index as i64 + 1],
            )?;
            tx.execute(
                "INSERT INTO define_ctq_nodes (id, project_id, parent_id, node_type, title, sort_order) VALUES (?1, ?2, ?3, 'driver', ?4, 1)",
                params![driver_id, project_id, need_id, driver],
            )?;
            tx.execute(
                "INSERT INTO define_ctq_nodes (id, project_id, parent_id, node_type, title, sort_order) VALUES (?1, ?2, ?3, 'ctq', ?4, 1)",
                params![new_id(), project_id, driver_id, format!("Define a measure and target for: {need}")],
            )?;
        }
        touch(&tx, &project_id)?;
        tx.commit()?;
        Ok(Json(json!({ "added": suggestions.len() })))
    })
    .await
}

// ---------------------------------------------------------------------------
// Evidence

struct EvidenceUpload {
    title: String,
    detail: String,
    file: Option<(String, String, Vec<u8>)>,
}

fn multipart_error(error: MultipartError) -> AppError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return AppError::Http(StatusCode::PAYLOAD_TOO_LARGE, "Evidence files must be 10 MB or smaller.".into());
    }
    AppError::Http(error.status(), format!("The upload could not be read: {}", error.body_text()))
}

fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    base.chars().filter(|c| !c.is_control()).take(200).collect::<String>().trim().to_owned()
}

fn sanitize_mime(mime: &str) -> String {
    let mime = mime.trim().to_ascii_lowercase();
    let token = |part: &str| {
        !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    match mime.split_once('/') {
        Some((kind, subtype)) if mime.len() <= 100 && token(kind) && token(subtype) => mime,
        _ => "application/octet-stream".into(),
    }
}

async fn read_evidence(mut multipart: Multipart) -> AppResult<EvidenceUpload> {
    let mut fields = Map::new();
    let mut file = None;
    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or_default().to_owned();
        if name == "file" {
            let file_name = sanitize_file_name(field.file_name().unwrap_or_default());
            let mime = sanitize_mime(field.content_type().unwrap_or_default());
            let bytes = field.bytes().await.map_err(multipart_error)?;
            if bytes.len() > MAX_EVIDENCE_BYTES {
                return Err(AppError::Http(StatusCode::PAYLOAD_TOO_LARGE, "Evidence files must be 10 MB or smaller.".into()));
            }
            if !bytes.is_empty() {
                let file_name = if file_name.is_empty() { "evidence".to_owned() } else { file_name };
                file = Some((file_name, mime, bytes.to_vec()));
            }
        } else if name == "title" || name == "detail" {
            fields.insert(name, Value::String(field.text().await.map_err(multipart_error)?));
        }
    }
    let body = Value::Object(fields);
    Ok(EvidenceUpload {
        title: required(&body, "title", "Evidence title", 240)?,
        detail: text(&body, "detail", "Description", 2000)?,
        file,
    })
}

pub async fn create_evidence(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(project_id): Path<String>,
    multipart: Multipart,
) -> AppResult<Json<Value>> {
    let upload = read_evidence(multipart).await?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let id = new_id();
        let (file_name, mime, data) = match upload.file {
            Some((name, mime, data)) => (name, mime, Some(data)),
            None => (String::new(), String::new(), None),
        };
        conn.execute(
            "INSERT INTO define_evidence (id, project_id, title, detail, file_name, mime_type, file_data, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, project_id, upload.title, upload.detail, file_name, mime, data, now()],
        )?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "id": id })))
    })
    .await
}

pub async fn update_evidence(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, evidence_id)): Path<(String, String)>,
    multipart: Multipart,
) -> AppResult<Json<Value>> {
    let upload = read_evidence(multipart).await?;
    db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        let changed = match upload.file {
            Some((file_name, mime, data)) => conn.execute(
                "UPDATE define_evidence SET title = ?1, detail = ?2, file_name = ?3, mime_type = ?4, file_data = ?5
                 WHERE id = ?6 AND project_id = ?7",
                params![upload.title, upload.detail, file_name, mime, data, evidence_id, project_id],
            )?,
            None => conn.execute(
                "UPDATE define_evidence SET title = ?1, detail = ?2 WHERE id = ?3 AND project_id = ?4",
                params![upload.title, upload.detail, evidence_id, project_id],
            )?,
        };
        expect_changed(changed)?;
        touch(conn, &project_id)?;
        Ok(Json(json!({ "id": evidence_id })))
    })
    .await
}

#[derive(Deserialize)]
pub struct FileQuery {
    inline: Option<String>,
}

fn encode_filename(name: &str) -> String {
    name.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

pub async fn evidence_file(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((project_id, evidence_id)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
) -> AppResult<Response> {
    let record = db::call(&state.db, move |conn| {
        access(conn, &user, &project_id)?;
        Ok(conn
            .query_row(
                "SELECT file_name, mime_type, file_data FROM define_evidence WHERE id = ?1 AND project_id = ?2",
                [&evidence_id, &project_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<Vec<u8>>>(2)?)),
            )
            .optional()?)
    })
    .await?;
    let Some((file_name, mime, Some(data))) = record else {
        return Err(AppError::not_found("This evidence record does not contain a file."));
    };
    // Uploaded files are served from the app's origin, so only types that cannot
    // run script are shown inline; everything else downloads as an attachment.
    let safe = INLINE_SAFE_TYPES.contains(&mime.as_str());
    let inline = safe && query.inline.is_some();
    let content_type = if safe { mime.as_str() } else { "application/octet-stream" };
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        encode_filename(if file_name.is_empty() { "evidence" } else { &file_name })
    );
    let mut response = data.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(content_type)?);
    headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition)?);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    if content_type != "application/pdf" {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; img-src 'self'"));
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// Settings

const DEFAULT_SETTINGS: &[(&str, &str)] = &[("date-format", "locale"), ("sidebar-start", "collapsed")];

/// Returns an error message if `key` is not a known setting or `value` is invalid for it.
pub fn validate_setting(key: &str, value: &str) -> Result<(), String> {
    let max_len = |max: usize| {
        if value.chars().count() <= max { Ok(()) } else { Err(format!("{key} must be {max} characters or fewer.")) }
    };
    match key {
        "date-format" if ["locale", "yyyy-mm-dd", "dd/mm/yyyy", "mm/dd/yyyy"].contains(&value) => Ok(()),
        "sidebar-start" if ["collapsed", "expanded"].contains(&value) => Ok(()),
        _ if key.strip_prefix("phase-color-").is_some_and(|phase| PHASES.contains(&phase)) => {
            let hex = value.strip_prefix('#').unwrap_or_default();
            if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                Ok(())
            } else {
                Err("Phase colors must be hex colors like #347fce.".into())
            }
        }
        "profile-name" | "profile-job-title" | "profile-company" | "profile-sigma-role" => max_len(120),
        "profile-email" => max_len(160),
        "profile-phone" => max_len(60),
        "profile-photo" => {
            let valid_prefix = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,"]
                .iter()
                .find_map(|prefix| value.strip_prefix(prefix));
            match valid_prefix {
                _ if value.is_empty() => Ok(()),
                Some(data) if data.len() <= 2_800_000 && data.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) => Ok(()),
                _ => Err("Profile photos must be JPG, PNG, or GIF images of 2 MB or less.".into()),
            }
        }
        "date-format" | "sidebar-start" => Err(format!("{key} is not a valid option.")),
        _ => Err(format!("Unknown setting: {key}")),
    }
}

fn load_settings(conn: &Connection, user_id: &str) -> AppResult<Value> {
    let mut settings: Map<String, Value> =
        DEFAULT_SETTINGS.iter().map(|(key, value)| (key.to_string(), Value::from(*value))).collect();
    let mut statement = conn.prepare("SELECT key, value FROM user_settings WHERE user_id = ?1")?;
    let rows = statement.query_map([user_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (key, value) = row?;
        settings.insert(key, Value::String(value));
    }
    Ok(Value::Object(settings))
}

pub async fn get_settings(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    db::call(&state.db, move |conn| Ok(Json(load_settings(conn, &user.id)?))).await
}

pub async fn put_settings(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Map<String, Value>>,
) -> AppResult<Json<Value>> {
    let mut updates = Vec::with_capacity(body.len());
    for (key, value) in body {
        let Value::String(value) = value else {
            return Err(AppError::bad_request(format!("{key} must be text.")));
        };
        let value = if key == "profile-photo" { value } else { value.trim().to_owned() };
        validate_setting(&key, &value).map_err(AppError::bad_request)?;
        updates.push((key, value));
    }
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        for (key, value) in &updates {
            tx.execute(
                "INSERT INTO user_settings (user_id, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                params![user.id, key, value],
            )?;
        }
        tx.commit()?;
        Ok(Json(load_settings(conn, &user.id)?))
    })
    .await
}
