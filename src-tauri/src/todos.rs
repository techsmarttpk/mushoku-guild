//! To-Do manager: lightweight personal tasks. A to-do is NOT a quest: it lives in its own table, never starts an AI run
//! and never touches quest records. To-dos are global by default; an optional repository tag only labels and filters.
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::db::{now_ms, Db};
use crate::events::{ErrorKind, ProviderError};

pub const PRIORITIES: [&str; 3] = ["low", "medium", "high"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub priority: String,
    /// local calendar date `YYYY-MM-DD`, no time zone
    pub due: Option<String>,
    pub done: bool,
    pub done_at: Option<i64>,
    /// optional repository tag; None = global
    pub project_id: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLS: &str = "id,title,description,priority,due,done,done_at,project_id,created_at,updated_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Todo> {
    Ok(Todo { id: r.get(0)?, title: r.get(1)?, description: r.get(2)?, priority: r.get(3)?, due: r.get(4)?, done: r.get::<_, i64>(5)? != 0, done_at: r.get(6)?, project_id: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)? })
}

/// `YYYY-MM-DD` with a plausible month and day.
pub fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |a: usize, z: usize| s[a..z].parse::<u32>().ok();
    matches!((num(0, 4), num(5, 7), num(8, 10)), (Some(y), Some(m), Some(d)) if y >= 1970 && (1..=12).contains(&m) && (1..=31).contains(&d))
}

pub struct Input<'a> {
    pub title: &'a str,
    pub description: &'a str,
    pub priority: &'a str,
    pub due: Option<&'a str>,
    pub project_id: Option<i64>,
}

fn check(db: &Db, i: &Input) -> Result<(), String> {
    if i.title.trim().is_empty() {
        return Err("Give the to-do a title.".into());
    }
    if i.title.chars().count() > 200 {
        return Err("The title is too long (200 characters maximum).".into());
    }
    if i.description.chars().count() > 5000 {
        return Err("The description is too long (5,000 characters maximum).".into());
    }
    if !PRIORITIES.contains(&i.priority) {
        return Err("Priority must be low, medium or high.".into());
    }
    if let Some(d) = i.due.filter(|d| !d.is_empty()) {
        if !valid_date(d) {
            return Err("The due date must look like 2026-12-31.".into());
        }
    }
    if let Some(p) = i.project_id {
        if db.project(p).is_none() {
            return Err("That repository no longer exists.".into());
        }
    }
    Ok(())
}

impl Db {
    pub fn todos(&self) -> Vec<Todo> {
        let c = self.c();
        let mut st = c.prepare(&format!("SELECT {COLS} FROM todos ORDER BY id")).expect("sql");
        st.query_map([], row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn todo(&self, id: i64) -> Option<Todo> {
        self.c().query_row(&format!("SELECT {COLS} FROM todos WHERE id=?1"), [id], row).optional().ok().flatten()
    }
    pub fn todo_create(&self, i: &Input) -> Result<Todo, String> {
        check(self, i)?;
        let now = now_ms();
        let due = i.due.filter(|d| !d.is_empty());
        let id = {
            let c = self.c();
            c.execute("INSERT INTO todos(title,description,priority,due,done,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,0,?5,?6,?6)", params![i.title.trim(), i.description.trim(), i.priority, due, i.project_id, now]).map_err(|e| e.to_string())?;
            c.last_insert_rowid()
        };
        self.todo(id).ok_or_else(|| "could not read the to-do back".into())
    }
    pub fn todo_update(&self, id: i64, i: &Input) -> Result<Todo, String> {
        check(self, i)?;
        let due = i.due.filter(|d| !d.is_empty());
        let n = self.c().execute("UPDATE todos SET title=?2,description=?3,priority=?4,due=?5,project_id=?6,updated_at=?7 WHERE id=?1", params![id, i.title.trim(), i.description.trim(), i.priority, due, i.project_id, now_ms()]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("That to-do no longer exists.".into());
        }
        self.todo(id).ok_or_else(|| "could not read the to-do back".into())
    }
    pub fn todo_set_done(&self, id: i64, done: bool) -> Result<Todo, String> {
        let now = now_ms();
        let n = self.c().execute("UPDATE todos SET done=?2, done_at=CASE WHEN ?2=1 THEN ?3 ELSE NULL END, updated_at=?3 WHERE id=?1", params![id, done as i64, now]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("That to-do no longer exists.".into());
        }
        self.todo(id).ok_or_else(|| "could not read the to-do back".into())
    }
    pub fn todo_delete(&self, id: i64) {
        let _ = self.c().execute("DELETE FROM todos WHERE id=?1", [id]);
    }
}

type R<T> = Result<T, ProviderError>;
fn e(m: String) -> ProviderError {
    ProviderError::new(ErrorKind::Other, m)
}

#[tauri::command]
pub fn todo_list(state: State<'_, AppState>) -> Vec<Todo> {
    state.db.todos()
}

#[tauri::command]
pub fn todo_save(state: State<'_, AppState>, id: Option<i64>, title: String, description: String, priority: String, due: Option<String>, project_id: Option<i64>) -> R<Todo> {
    let input = Input { title: &title, description: &description, priority: &priority, due: due.as_deref(), project_id };
    match id {
        Some(id) => state.db.todo_update(id, &input),
        None => state.db.todo_create(&input),
    }
    .map_err(e)
}

#[tauri::command]
pub fn todo_set_done(state: State<'_, AppState>, id: i64, done: bool) -> R<Todo> {
    state.db.todo_set_done(id, done).map_err(e)
}

#[tauri::command]
pub fn todo_delete(state: State<'_, AppState>, id: i64) {
    state.db.todo_delete(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(title: &'a str, project_id: Option<i64>) -> Input<'a> {
        Input { title, description: "", priority: "medium", due: None, project_id }
    }

    #[test]
    fn create_edit_complete_and_delete() {
        let db = Db::open_in_memory();
        let t = db.todo_create(&Input { title: "  Fix authentication UI ", description: "login form", priority: "high", due: Some("2026-12-01"), project_id: None }).unwrap();
        assert_eq!((t.title.as_str(), t.priority.as_str(), t.due.as_deref(), t.done), ("Fix authentication UI", "high", Some("2026-12-01"), false));
        let t = db.todo_update(t.id, &Input { title: "Fix auth UI", description: "", priority: "low", due: Some(""), project_id: None }).unwrap();
        assert_eq!((t.title.as_str(), t.priority.as_str(), t.due), ("Fix auth UI", "low", None), "an empty due date clears it");
        let done = db.todo_set_done(t.id, true).unwrap();
        assert!(done.done && done.done_at.is_some());
        let undone = db.todo_set_done(t.id, false).unwrap();
        assert!(!undone.done && undone.done_at.is_none());
        db.todo_delete(t.id);
        assert!(db.todo(t.id).is_none() && db.todos().is_empty());
        assert!(db.todo_set_done(999, true).is_err() && db.todo_update(999, &input("x", None)).is_err());
    }

    #[test]
    fn invalid_input_is_refused_with_a_reason() {
        let db = Db::open_in_memory();
        assert!(db.todo_create(&input("   ", None)).unwrap_err().contains("title"));
        assert!(db.todo_create(&Input { priority: "urgent", ..input("x", None) }).unwrap_err().contains("Priority"));
        assert!(db.todo_create(&Input { due: Some("31/12/2026"), ..input("x", None) }).unwrap_err().contains("due date"));
        assert!(db.todo_create(&Input { due: Some("2026-13-01"), ..input("x", None) }).is_err());
        assert!(db.todo_create(&input("x", Some(42))).unwrap_err().contains("repository"));
        assert!(db.todo_create(&input(&"t".repeat(201), None)).is_err());
        assert!(valid_date("2026-02-28") && !valid_date("2026-2-28") && !valid_date("abcd-ef-gh"));
    }

    #[test]
    fn todos_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("mg-todo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let id = {
            let db = Db::open(&path).unwrap();
            let t = db.todo_create(&Input { title: "Read the paper", description: "attention", priority: "low", due: Some("2027-01-05"), project_id: None }).unwrap();
            db.todo_set_done(t.id, true).unwrap();
            t.id
        };
        let db = Db::open(&path).unwrap();
        let t = db.todo(id).unwrap();
        assert!(t.done && t.title == "Read the paper" && t.due.as_deref() == Some("2027-01-05") && t.description == "attention");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn global_and_repository_todos_coexist_and_never_become_quests() {
        let db = Db::open_in_memory();
        let a = db.add_project("C:\\a", "a").unwrap();
        let b = db.add_project("C:\\b", "b").unwrap();
        let g = db.todo_create(&input("global", None)).unwrap();
        let ta = db.todo_create(&input("in a", Some(a.id))).unwrap();
        db.todo_create(&input("in b", Some(b.id))).unwrap();
        // every to-do is always listed, whichever repository is active: filtering is a UI choice, not a storage one
        assert_eq!(db.todos().len(), 3);
        assert_eq!(db.todo(g.id).unwrap().project_id, None);
        assert_eq!(db.todo(ta.id).unwrap().project_id, Some(a.id));
        // to-dos and quests are different records
        assert!(db.tasks(a.id).is_empty() && db.quest_history(a.id).is_empty());
        // removing a repository keeps the to-do and makes it global
        db.c().execute("DELETE FROM projects WHERE id=?1", [a.id]).unwrap();
        assert_eq!(db.todo(ta.id).unwrap().project_id, None);
        assert_eq!(db.todos().len(), 3);
        // retagging works
        let moved = db.todo_update(g.id, &input("global", Some(b.id))).unwrap();
        assert_eq!(moved.project_id, Some(b.id));
    }
}
