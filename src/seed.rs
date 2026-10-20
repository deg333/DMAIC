use rusqlite::{params, Connection};

use crate::{
    db::{new_id, now},
    error::AppResult,
};

/// Gives each new account the sample injection-molding project to explore.
pub fn example_project(conn: &Connection, user_id: &str) -> AppResult<()> {
    let id = new_id();
    let now = now();
    conn.execute(
        "INSERT INTO projects (id, owner_user_id, name, problem, owner, status, current_phase, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'In progress', 'analyze', ?6, ?6)",
        params![
            id,
            user_id,
            "Injection Molding Scrap & Flash Reduction",
            "Hydraulic Press #4 scrap rate currently averages 7.4% against a 1.5% target due to excessive parting-line flash and sink marks on automotive bumper clips, generating $320,000/yr in scrap.",
            "Manufacturing Excellence",
            now,
        ],
    )?;
    let examples = [
        ("define", "charter", "Reduce scrap from 7.4% to below 1.5%", "Reduce scrap rate and achieve stable part-weight capability within 16 weeks.", "Project sponsor", "In progress"),
        ("measure", "metrics", "Hourly scrap rate", "Track scrap parts divided by total production, by press, cavity, and shift.", "Quality engineer", "In progress"),
        ("measure", "metrics", "Part weight", "Collect five-piece subgroups every hour; record cavity and material lot.", "Process technician", "Not started"),
        ("analyze", "fishbone", "Moisture variation", "Check dryer dew point and resin moisture readings across shifts.", "Process engineer", "In progress"),
        ("analyze", "5-whys", "Flash concentrated on night shift", "Validate whether setup, clamp tonnage, or mold temperature changes by shift.", "Manufacturing lead", "Not started"),
        ("control", "control-plan", "Hourly scrap rate", "SPC / data collection · Hourly total · Process owner · Stop and correct.", "Process owner", "Not started"),
    ];
    let mut insert = conn.prepare(
        "INSERT INTO phase_entries (id, project_id, phase, tab, title, detail, owner, status, due_date, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9, ?9)",
    )?;
    for (phase, tab, title, detail, owner, status) in examples {
        insert.execute(params![new_id(), id, phase, tab, title, detail, owner, status, now])?;
    }
    Ok(())
}
