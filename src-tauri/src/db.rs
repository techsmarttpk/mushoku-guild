//! SQLite persistence (Rust-owned; the frontend never sees SQL). Credentials are NOT stored here.
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Activity events kept per execution, and executions whose events are kept at all (bounded history).
const MAX_EVENTS_PER_EXECUTION: i64 = 1500;
const KEEP_EVENTS_FOR_EXECUTIONS: i64 = 40;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX tasks_project ON tasks(project_id, updated_at DESC);
CREATE TABLE task_messages (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE prompt_drafts (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, model TEXT,
  approved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE executions (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  prompt_draft_id INTEGER REFERENCES prompt_drafts(id), policy TEXT NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, result_text TEXT, num_turns INTEGER,
  denial_count INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX events_exec ON events(execution_id, seq);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY, execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, tool_name TEXT NOT NULL, input_summary TEXT NOT NULL,
  decision TEXT NOT NULL, decided_by TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#,
r#"
ALTER TABLE executions ADD COLUMN exit_code INTEGER;
ALTER TABLE executions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask';
CREATE TABLE chat_conversations (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX chat_conv_project ON chat_conversations(project_id, id DESC);
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX chat_msg_conv ON chat_messages(conversation_id, id);
CREATE TABLE repo_research (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL, report TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]',
  researched_at INTEGER NOT NULL, fingerprint TEXT NOT NULL DEFAULT '', note TEXT);
"#,
r#"
ALTER TABLE projects ADD COLUMN identity TEXT NOT NULL DEFAULT '';
ALTER TABLE executions ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
CREATE TABLE repo_prefs (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  trusted INTEGER NOT NULL DEFAULT 0, policy TEXT NOT NULL DEFAULT 'ask_each', autopilot INTEGER NOT NULL DEFAULT 0,
  trusted_identity TEXT NOT NULL DEFAULT '', trusted_path TEXT NOT NULL DEFAULT '', trusted_at INTEGER);
CREATE TABLE research_sessions (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  objective TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, findings TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE services (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT NOT NULL, url TEXT, pid INTEGER, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE library_docs (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path TEXT NOT NULL, title TEXT NOT NULL,
  size INTEGER NOT NULL, modified INTEGER NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (project_id, path));
"#,
r#"
CREATE TABLE task_attachments (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, stored TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX task_attachments_task ON task_attachments(task_id, id);
CREATE TABLE uchat_conversations (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('chatgpt','claude')),
  model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX uchat_conv_updated ON uchat_conversations(updated_at DESC, id DESC);
CREATE TABLE uchat_messages (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES uchat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL);
CREATE INDEX uchat_msg_conv ON uchat_messages(conversation_id, id);
"#,
r#"
CREATE TABLE todos (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  due TEXT, done INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX todos_done ON todos(done, due);
"#];

/// Task lifecycle. `from -> to` pairs not listed here are rejected.
pub fn transition_allowed(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("draft", "reasoning")
            | ("reasoning", "prompt_ready")
            | ("reasoning", "draft")
            | ("prompt_ready", "reasoning")
            | ("prompt_ready", "approved")
            | ("approved", "running")
            | ("approved", "reasoning")
            | ("running", "completed")
            | ("running", "failed")
            | ("running", "cancelled")
            | ("completed", "accepted")
            | ("completed", "reasoning")
            | ("completed", "approved")
            | ("accepted", "approved")
            | ("failed", "reasoning")
            | ("failed", "approved")
            | ("cancelled", "reasoning")
            | ("cancelled", "approved")
    )
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub last_used_at: i64,
    pub identity: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub description: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: i64,
    pub task_id: i64,
    pub version: i64,
    pub body: String,
    pub source: String,
    pub model: Option<String>,
    pub approved: bool,
    pub created_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: i64,
    pub task_id: i64,
    pub policy: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub result_text: Option<String>,
    pub num_turns: Option<i64>,
    pub denial_count: i64,
    pub note: Option<String>,
    pub exit_code: Option<i64>,
    pub permission_mode: String,
    pub model: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub title: String,
    pub detail: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub body: String,
    pub created_at: i64,
    /// text | agent (Claude's findings) | doc (an attached document)
    pub kind: String,
    /// complete | streaming | interrupted
    pub status: String,
}

/// Claude's repository research for one project (read-only; stored locally, redacted).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Research {
    pub project_id: i64,
    /// "researching" | "ready" | "failed" | "cancelled" (the UI derives "stale"/"none")
    pub status: String,
    pub report: String,
    pub files: Vec<String>,
    pub researched_at: i64,
    pub fingerprint: String,
    pub note: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrefsRow {
    pub trusted: bool,
    pub policy: String,
    pub autopilot: bool,
    pub trusted_identity: String,
    pub trusted_path: String,
    pub trusted_at: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConvSummary {
    pub id: i64,
    pub title: String,
    pub updated_at: i64,
    pub message_count: i64,
    pub snippet: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuestRow {
    pub id: i64,
    pub title: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model: String,
    pub permission_mode: String,
    pub summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRow {
    pub id: i64,
    pub task_id: i64,
    pub kind: String,
    pub label: String,
    pub url: Option<String>,
    pub pid: Option<i64>,
    pub status: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMeta {
    pub path: String,
    pub title: String,
    pub size: i64,
    pub modified: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub task: Task,
    pub drafts: Vec<Draft>,
    pub executions: Vec<Execution>,
    pub events: Vec<StoredEvent>,
}

pub struct Db {
    conn: Mutex<Connection>,
    /// Set when a corrupt database was moved aside at start-up; shown to the user once.
    pub recovered_note: Option<String>,
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);")?;
    let current: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = i as i64 + 1;
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)", params![version, now_ms()])?;
        tx.commit()?;
    }
    Ok(())
}

fn open_checked(path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            Some(format!("quick_check: {check}")),
        ));
    }
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&mut conn)?;
    Ok(conn)
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        match open_checked(path) {
            Ok(conn) => Ok(Db { conn: Mutex::new(conn), recovered_note: None }),
            Err(first) => {
                // Recovery: keep the unreadable file for the user, start with a fresh database.
                let aside = path.with_extension(format!("corrupt-{}", now_ms()));
                std::fs::rename(path, &aside).map_err(|e| format!("database unusable ({first}) and could not be moved aside: {e}"))?;
                for ext in ["db-wal", "db-shm"] {
                    let _ = std::fs::remove_file(path.with_extension(ext));
                }
                let conn = open_checked(path).map_err(|e| format!("could not create a new database: {e}"))?;
                Ok(Db {
                    conn: Mutex::new(conn),
                    recovered_note: Some(format!("The task database could not be opened ({first}). It was moved to {} and a new one was created.", aside.display())),
                })
            }
        }
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Db {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        conn.pragma_update(None, "foreign_keys", "ON").expect("pragma");
        migrate(&mut conn).expect("migrate");
        Db { conn: Mutex::new(conn), recovered_note: None }
    }

    pub(crate) fn c(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ---- settings
    pub fn setting(&self, key: &str) -> Option<String> {
        self.c().query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.c()
            .execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    // ---- projects
    #[cfg(test)]
    pub fn add_project(&self, path: &str, name: &str) -> Result<Project, String> {
        self.add_project_with_identity(path, name, "")
    }
    pub fn add_project_with_identity(&self, path: &str, name: &str, identity: &str) -> Result<Project, String> {
        let now = now_ms();
        let c = self.c();
        c.execute(
            "INSERT INTO projects(path,name,created_at,last_used_at,identity) VALUES(?1,?2,?3,?3,?4)
             ON CONFLICT(path) DO UPDATE SET last_used_at=excluded.last_used_at, identity=CASE WHEN excluded.identity<>'' THEN excluded.identity ELSE projects.identity END",
            params![path, name, now, identity],
        )
        .map_err(|e| e.to_string())?;
        c.query_row("SELECT id,path,name,last_used_at,identity FROM projects WHERE path=?1", [path], project_row).map_err(|e| e.to_string())
    }
    pub fn projects(&self) -> Vec<Project> {
        let c = self.c();
        let mut st = c.prepare("SELECT id,path,name,last_used_at,identity FROM projects ORDER BY last_used_at DESC").expect("sql");
        st.query_map([], project_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn project(&self, id: i64) -> Option<Project> {
        self.c().query_row("SELECT id,path,name,last_used_at,identity FROM projects WHERE id=?1", [id], project_row).optional().ok().flatten()
    }
    /// A repository found again (moved or renamed): keep every record, point it at the new folder.
    pub fn relink_project(&self, id: i64, path: &str, name: &str, identity: &str) -> Result<(), String> {
        self.c()
            .execute("UPDATE projects SET path=?2, name=?3, identity=?4, last_used_at=?5 WHERE id=?1", params![id, path, name, identity, now_ms()])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn set_identity(&self, id: i64, identity: &str) {
        let _ = self.c().execute("UPDATE projects SET identity=?2 WHERE id=?1", params![id, identity]);
    }
    pub fn project_by_identity(&self, identity: &str) -> Option<Project> {
        if identity.is_empty() {
            return None;
        }
        self.c().query_row("SELECT id,path,name,last_used_at,identity FROM projects WHERE identity=?1 ORDER BY id LIMIT 1", [identity], project_row).optional().ok().flatten()
    }
    pub fn touch_project(&self, id: i64) {
        let _ = self.c().execute("UPDATE projects SET last_used_at=?2 WHERE id=?1", params![id, now_ms()]);
    }

    // ---- tasks
    pub fn create_task(&self, project_id: i64, title: &str, description: &str) -> Result<Task, String> {
        let now = now_ms();
        let c = self.c();
        c.execute(
            "INSERT INTO tasks(project_id,title,description,status,created_at,updated_at) VALUES(?1,?2,?3,'draft',?4,?4)",
            params![project_id, title, description, now],
        )
        .map_err(|e| e.to_string())?;
        let id = c.last_insert_rowid();
        c.execute("INSERT INTO task_messages(task_id,role,body,created_at) VALUES(?1,'user',?2,?3)", params![id, description, now])
            .map_err(|e| e.to_string())?;
        c.query_row(TASK_SQL_ONE, [id], task_row).map_err(|e| e.to_string())
    }
    pub fn task(&self, id: i64) -> Option<Task> {
        self.c().query_row(TASK_SQL_ONE, [id], task_row).optional().ok().flatten()
    }
    pub fn tasks(&self, project_id: i64) -> Vec<Task> {
        let c = self.c();
        let mut st = c
            .prepare("SELECT id,project_id,title,description,status,created_at,updated_at FROM tasks WHERE project_id=?1 ORDER BY updated_at DESC LIMIT 200")
            .expect("sql");
        st.query_map([project_id], task_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    /// Validates the transition against the state machine before writing it.
    pub fn set_status(&self, task_id: i64, to: &str) -> Result<(), String> {
        let c = self.c();
        let from: String = c.query_row("SELECT status FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if from != to && !transition_allowed(&from, to) {
            return Err(format!("task cannot go from '{from}' to '{to}'"));
        }
        c.execute("UPDATE tasks SET status=?2, updated_at=?3 WHERE id=?1", params![task_id, to, now_ms()]).map(|_| ()).map_err(|e| e.to_string())
    }
    pub fn add_message(&self, task_id: i64, role: &str, body: &str) {
        let _ = self.c().execute("INSERT INTO task_messages(task_id,role,body,created_at) VALUES(?1,?2,?3,?4)", params![task_id, role, body, now_ms()]);
    }
    pub fn messages(&self, task_id: i64) -> Vec<(String, String)> {
        let c = self.c();
        let mut st = c.prepare("SELECT role,body FROM task_messages WHERE task_id=?1 ORDER BY id").expect("sql");
        st.query_map([task_id], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    // ---- prompt drafts
    pub fn add_draft(&self, task_id: i64, body: &str, source: &str, model: Option<&str>) -> Result<Draft, String> {
        let c = self.c();
        let version: i64 = c.query_row("SELECT COALESCE(MAX(version),0)+1 FROM prompt_drafts WHERE task_id=?1", [task_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO prompt_drafts(task_id,version,body,source,model,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![task_id, version, body, source, model, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        let id = c.last_insert_rowid();
        c.execute("UPDATE tasks SET updated_at=?2 WHERE id=?1", params![task_id, now_ms()]).map_err(|e| e.to_string())?;
        c.query_row(DRAFT_SQL_ONE, [id], draft_row).map_err(|e| e.to_string())
    }
    pub fn drafts(&self, task_id: i64) -> Vec<Draft> {
        let c = self.c();
        let mut st = c
            .prepare("SELECT id,task_id,version,body,source,model,approved,created_at FROM prompt_drafts WHERE task_id=?1 ORDER BY version")
            .expect("sql");
        st.query_map([task_id], draft_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn draft(&self, id: i64) -> Option<Draft> {
        self.c().query_row(DRAFT_SQL_ONE, [id], draft_row).optional().ok().flatten()
    }
    pub fn approve_draft(&self, draft_id: i64) -> Result<(), String> {
        self.c().execute("UPDATE prompt_drafts SET approved=1 WHERE id=?1", [draft_id]).map(|_| ()).map_err(|e| e.to_string())
    }

    // ---- executions, events, approvals
    pub fn start_execution(&self, task_id: i64, draft_id: i64, policy: &str, permission_mode: &str, model: &str) -> Result<i64, String> {
        let c = self.c();
        c.execute(
            "INSERT INTO executions(task_id,prompt_draft_id,policy,status,started_at,permission_mode,model) VALUES(?1,?2,?3,'running',?4,?5,?6)",
            params![task_id, draft_id, policy, now_ms(), permission_mode, model],
        )
        .map_err(|e| e.to_string())?;
        Ok(c.last_insert_rowid())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn finish_execution(&self, id: i64, status: &str, result_text: Option<&str>, num_turns: Option<i64>, denials: i64, note: Option<&str>, exit_code: Option<i64>) {
        // `AND status='running'` makes the terminal state write-once: a duplicate finish cannot change an outcome.
        let _ = self.c().execute(
            "UPDATE executions SET status=?2, ended_at=?3, result_text=?4, num_turns=?5, denial_count=?6, note=?7, exit_code=?8 WHERE id=?1 AND status='running'",
            params![id, status, now_ms(), result_text, num_turns, denials, note, exit_code],
        );
        self.prune_events();
    }
    pub fn add_event(&self, execution_id: i64, seq: i64, kind: &str, title: &str, detail: &str) {
        let c = self.c();
        if seq > MAX_EVENTS_PER_EXECUTION {
            return; // bounded history: later events of a runaway execution are live-only
        }
        let _ = c.execute(
            "INSERT INTO events(execution_id,seq,ts,kind,title,detail) VALUES(?1,?2,?3,?4,?5,?6)",
            params![execution_id, seq, now_ms(), kind, title, detail],
        );
    }
    pub fn add_approval(&self, execution_id: i64, tool: &str, summary: &str, decision: &str, by: &str) {
        let _ = self.c().execute(
            "INSERT INTO approvals(execution_id,ts,tool_name,input_summary,decision,decided_by) VALUES(?1,?2,?3,?4,?5,?6)",
            params![execution_id, now_ms(), tool, summary, decision, by],
        );
    }
    fn prune_events(&self) {
        let _ = self.c().execute(
            "DELETE FROM events WHERE execution_id NOT IN (SELECT id FROM executions ORDER BY id DESC LIMIT ?1)",
            [KEEP_EVENTS_FOR_EXECUTIONS],
        );
    }
    pub fn executions(&self, task_id: i64) -> Vec<Execution> {
        let c = self.c();
        let mut st = c
            .prepare("SELECT id,task_id,policy,status,started_at,ended_at,result_text,num_turns,denial_count,note,exit_code,permission_mode,model FROM executions WHERE task_id=?1 ORDER BY id")
            .expect("sql");
        st.query_map([task_id], |r| {
            Ok(Execution {
                id: r.get(0)?,
                task_id: r.get(1)?,
                policy: r.get(2)?,
                status: r.get(3)?,
                started_at: r.get(4)?,
                ended_at: r.get(5)?,
                result_text: r.get(6)?,
                num_turns: r.get(7)?,
                denial_count: r.get(8)?,
                note: r.get(9)?,
                exit_code: r.get(10)?,
                permission_mode: r.get(11)?,
                model: r.get(12)?,
            })
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }
    pub fn events_for_latest_execution(&self, task_id: i64) -> Vec<StoredEvent> {
        let c = self.c();
        let mut st = c
            .prepare(
                "SELECT seq,ts,kind,title,detail FROM events WHERE execution_id=(SELECT MAX(id) FROM executions WHERE task_id=?1) ORDER BY seq",
            )
            .expect("sql");
        st.query_map([task_id], |r| Ok(StoredEvent { seq: r.get(0)?, ts: r.get(1)?, kind: r.get(2)?, title: r.get(3)?, detail: r.get(4)? }))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    // ---- chat
    pub fn latest_conversation(&self, project_id: i64) -> Option<Conversation> {
        self.c()
            .query_row("SELECT id,project_id,title,updated_at FROM chat_conversations WHERE project_id=?1 ORDER BY id DESC LIMIT 1", [project_id], conv_row)
            .optional()
            .ok()
            .flatten()
    }
    pub fn create_conversation(&self, project_id: i64) -> Result<Conversation, String> {
        let now = now_ms();
        let c = self.c();
        c.execute("INSERT INTO chat_conversations(project_id,title,created_at,updated_at) VALUES(?1,'New conversation',?2,?2)", params![project_id, now]).map_err(|e| e.to_string())?;
        let id = c.last_insert_rowid();
        c.query_row("SELECT id,project_id,title,updated_at FROM chat_conversations WHERE id=?1", [id], conv_row).map_err(|e| e.to_string())
    }
    pub fn conversation(&self, id: i64) -> Option<Conversation> {
        self.c().query_row("SELECT id,project_id,title,updated_at FROM chat_conversations WHERE id=?1", [id], conv_row).optional().ok().flatten()
    }
    pub fn chat_messages(&self, conversation_id: i64) -> Vec<ChatMessage> {
        let c = self.c();
        let mut st = c.prepare("SELECT id,conversation_id,role,body,created_at,kind,status FROM chat_messages WHERE conversation_id=?1 ORDER BY id").expect("sql");
        st.query_map([conversation_id], msg_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn add_chat_message(&self, conversation_id: i64, role: &str, body: &str) -> Result<ChatMessage, String> {
        let now = now_ms();
        let c = self.c();
        c.execute("INSERT INTO chat_messages(conversation_id,role,body,created_at) VALUES(?1,?2,?3,?4)", params![conversation_id, role, body, now]).map_err(|e| e.to_string())?;
        let id = c.last_insert_rowid();
        let _ = c.execute("UPDATE chat_conversations SET updated_at=?2 WHERE id=?1", params![conversation_id, now]);
        c.query_row("SELECT id,conversation_id,role,body,created_at,kind,status FROM chat_messages WHERE id=?1", [id], msg_row).map_err(|e| e.to_string())
    }

    // ---- repository research
    pub fn research(&self, project_id: i64) -> Option<Research> {
        self.c()
            .query_row("SELECT project_id,status,report,files,researched_at,fingerprint,note FROM repo_research WHERE project_id=?1", [project_id], |r| {
                let files: String = r.get(3)?;
                Ok(Research {
                    project_id: r.get(0)?,
                    status: r.get(1)?,
                    report: r.get(2)?,
                    files: serde_json::from_str(&files).unwrap_or_default(),
                    researched_at: r.get(4)?,
                    fingerprint: r.get(5)?,
                    note: r.get(6)?,
                })
            })
            .optional()
            .ok()
            .flatten()
    }
    /// Marks research as running while keeping any earlier report.
    pub fn research_started(&self, project_id: i64) {
        let _ = self.c().execute(
            "INSERT INTO repo_research(project_id,status,researched_at) VALUES(?1,'researching',?2)
             ON CONFLICT(project_id) DO UPDATE SET status='researching', note=NULL",
            params![project_id, now_ms()],
        );
    }
    /// Stores a finished research. A failed or cancelled run keeps the previous report.
    pub fn research_finished(&self, project_id: i64, status: &str, report: Option<&str>, files: &[String], fingerprint: &str, note: Option<&str>) {
        let files_json = serde_json::to_string(files).unwrap_or_else(|_| "[]".into());
        let c = self.c();
        let _ = c.execute(
            "INSERT INTO repo_research(project_id,status,report,files,researched_at,fingerprint,note) VALUES(?1,?2,COALESCE(?3,''),?4,?5,?6,?7)
             ON CONFLICT(project_id) DO UPDATE SET status=?2, note=?7,
               report=COALESCE(?3, report), files=CASE WHEN ?3 IS NULL THEN files ELSE ?4 END,
               researched_at=CASE WHEN ?3 IS NULL THEN researched_at ELSE ?5 END,
               fingerprint=CASE WHEN ?3 IS NULL THEN fingerprint ELSE ?6 END",
            params![project_id, status, report, files_json, now_ms(), fingerprint, note],
        );
    }

    // ---- per-repository permission preferences
    pub fn repo_prefs(&self, project_id: i64) -> Option<RepoPrefsRow> {
        self.c()
            .query_row("SELECT trusted,policy,autopilot,trusted_identity,trusted_path,trusted_at FROM repo_prefs WHERE project_id=?1", [project_id], |r| {
                Ok(RepoPrefsRow { trusted: r.get::<_, i64>(0)? != 0, policy: r.get(1)?, autopilot: r.get::<_, i64>(2)? != 0, trusted_identity: r.get(3)?, trusted_path: r.get(4)?, trusted_at: r.get(5)? })
            })
            .optional()
            .ok()
            .flatten()
    }
    pub fn save_repo_prefs(&self, project_id: i64, trusted: bool, policy: &str, autopilot: bool, identity: &str, path: &str) -> Result<(), String> {
        self.c()
            .execute(
                "INSERT INTO repo_prefs(project_id,trusted,policy,autopilot,trusted_identity,trusted_path,trusted_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(project_id) DO UPDATE SET trusted=?2, policy=?3, autopilot=?4, trusted_identity=?5, trusted_path=?6, trusted_at=?7",
                params![project_id, trusted as i64, policy, autopilot as i64, identity, path, if trusted { Some(now_ms()) } else { None }],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn revoke_repo_prefs(&self, project_id: i64) {
        let _ = self.c().execute("DELETE FROM repo_prefs WHERE project_id=?1", [project_id]);
    }

    // ---- quest history
    pub fn quest_history(&self, project_id: i64) -> Vec<QuestRow> {
        let c = self.c();
        let mut st = c
            .prepare(
                "SELECT t.id, t.title, t.status, t.created_at, t.updated_at,
                        COALESCE((SELECT e.model FROM executions e WHERE e.task_id=t.id ORDER BY e.id DESC LIMIT 1), ''),
                        COALESCE((SELECT e.permission_mode FROM executions e WHERE e.task_id=t.id ORDER BY e.id DESC LIMIT 1), ''),
                        COALESCE((SELECT substr(COALESCE(e.result_text, e.note, ''), 1, 160) FROM executions e WHERE e.task_id=t.id ORDER BY e.id DESC LIMIT 1), '')
                 FROM tasks t WHERE t.project_id=?1 ORDER BY t.updated_at DESC LIMIT 300",
            )
            .expect("sql");
        st.query_map([project_id], |r| {
            Ok(QuestRow { id: r.get(0)?, title: r.get(1)?, status: r.get(2)?, created_at: r.get(3)?, updated_at: r.get(4)?, model: r.get(5)?, permission_mode: r.get(6)?, summary: r.get(7)? })
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    // ---- chat conversation management
    pub fn conversations(&self, project_id: i64, query: &str) -> Vec<ConvSummary> {
        let c = self.c();
        let like = format!("%{}%", query.trim().replace('%', "").replace('_', ""));
        let mut st = c
            .prepare(
                "SELECT c.id, c.title, c.updated_at, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id=c.id AND m.kind<>'doc'),
                        COALESCE((SELECT substr(m.body,1,120) FROM chat_messages m WHERE m.conversation_id=c.id AND m.kind<>'doc' AND ?3<>'' AND m.body LIKE ?2 ORDER BY m.id LIMIT 1), '')
                 FROM chat_conversations c
                 WHERE c.project_id=?1 AND (?3='' OR c.title LIKE ?2 OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id=c.id AND m.body LIKE ?2))
                   AND (EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id=c.id) OR c.id=(SELECT MAX(id) FROM chat_conversations WHERE project_id=?1))
                 ORDER BY c.updated_at DESC, c.id DESC LIMIT 200",
            )
            .expect("sql");
        st.query_map(params![project_id, like, query.trim()], |r| Ok(ConvSummary { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)?, message_count: r.get(3)?, snippet: r.get(4)? }))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }
    pub fn rename_conversation(&self, id: i64, title: &str) {
        let _ = self.c().execute("UPDATE chat_conversations SET title=?2 WHERE id=?1", params![id, title]);
    }
    pub fn delete_conversation(&self, id: i64) {
        let _ = self.c().execute("DELETE FROM chat_conversations WHERE id=?1", [id]);
    }
    pub fn add_chat_message_kind(&self, conversation_id: i64, role: &str, body: &str, kind: &str, status: &str) -> Result<ChatMessage, String> {
        let now = now_ms();
        let c = self.c();
        c.execute("INSERT INTO chat_messages(conversation_id,role,body,created_at,kind,status) VALUES(?1,?2,?3,?4,?5,?6)", params![conversation_id, role, body, now, kind, status]).map_err(|e| e.to_string())?;
        let id = c.last_insert_rowid();
        let _ = c.execute("UPDATE chat_conversations SET updated_at=?2 WHERE id=?1", params![conversation_id, now]);
        c.query_row("SELECT id,conversation_id,role,body,created_at,kind,status FROM chat_messages WHERE id=?1", [id], msg_row).map_err(|e| e.to_string())
    }
    pub fn update_chat_message(&self, id: i64, body: &str, status: &str) {
        let _ = self.c().execute("UPDATE chat_messages SET body=?2, status=?3 WHERE id=?1", params![id, body, status]);
    }
    pub fn delete_chat_message(&self, id: i64) {
        let _ = self.c().execute("DELETE FROM chat_messages WHERE id=?1", [id]);
    }
    pub fn chat_message(&self, id: i64) -> Option<ChatMessage> {
        self.c().query_row("SELECT id,conversation_id,role,body,created_at,kind,status FROM chat_messages WHERE id=?1", [id], msg_row).optional().ok().flatten()
    }
    pub fn set_title_if_new(&self, id: i64, title: &str) {
        let _ = self.c().execute("UPDATE chat_conversations SET title=?2 WHERE id=?1 AND title='New conversation'", params![id, title]);
    }
    pub fn add_research_session(&self, conversation_id: i64, objective: &str, question: &str, status: &str, findings: &str, files: &[String]) {
        let _ = self.c().execute(
            "INSERT INTO research_sessions(conversation_id,objective,question,status,findings,files,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![conversation_id, objective, question, status, findings, serde_json::to_string(files).unwrap_or_else(|_| "[]".into()), now_ms()],
        );
    }

    // ---- launched services (dev servers, apps, URLs) belong to the quest, not to its execution lifecycle
    pub fn add_service(&self, task_id: i64, kind: &str, label: &str, url: Option<&str>, pid: Option<i64>) -> i64 {
        let c = self.c();
        let _ = c.execute("INSERT INTO services(task_id,kind,label,url,pid,status,created_at) VALUES(?1,?2,?3,?4,?5,'running',?6)", params![task_id, kind, label, url, pid, now_ms()]);
        c.last_insert_rowid()
    }
    pub fn has_url_service(&self, task_id: i64, url: &str) -> bool {
        self.c().query_row("SELECT 1 FROM services WHERE task_id=?1 AND kind='url' AND url=?2", params![task_id, url], |_| Ok(())).optional().ok().flatten().is_some()
    }
    pub fn services(&self, task_id: i64) -> Vec<ServiceRow> {
        let c = self.c();
        let mut st = c.prepare("SELECT id,task_id,kind,label,url,pid,status,created_at FROM services WHERE task_id=?1 ORDER BY id").expect("sql");
        st.query_map([task_id], |r| Ok(ServiceRow { id: r.get(0)?, task_id: r.get(1)?, kind: r.get(2)?, label: r.get(3)?, url: r.get(4)?, pid: r.get(5)?, status: r.get(6)?, created_at: r.get(7)? }))
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }
    pub fn service(&self, id: i64) -> Option<ServiceRow> {
        self.c()
            .query_row("SELECT id,task_id,kind,label,url,pid,status,created_at FROM services WHERE id=?1", [id], |r| {
                Ok(ServiceRow { id: r.get(0)?, task_id: r.get(1)?, kind: r.get(2)?, label: r.get(3)?, url: r.get(4)?, pid: r.get(5)?, status: r.get(6)?, created_at: r.get(7)? })
            })
            .optional()
            .ok()
            .flatten()
    }
    pub fn set_service_status(&self, id: i64, status: &str) {
        let _ = self.c().execute("UPDATE services SET status=?2, ended_at=?3 WHERE id=?1", params![id, status, now_ms()]);
    }

    // ---- quest attachments (metadata only; the files live in managed storage, see attachments.rs)
    pub fn add_attachment(&self, task_id: i64, project_id: i64, name: &str, kind: &str, mime: &str, size: i64, ext: &str) -> Result<crate::attachments::AttachmentRow, String> {
        let mut c = self.c();
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO task_attachments(task_id,project_id,name,kind,mime,size,stored,created_at) VALUES(?1,?2,?3,?4,?5,?6,'',?7)", params![task_id, project_id, name, kind, mime, size, now_ms()]).map_err(|e| e.to_string())?;
        let id = tx.last_insert_rowid();
        let stored = crate::attachments::relative_path(project_id, task_id, id, ext);
        tx.execute("UPDATE task_attachments SET stored=?2 WHERE id=?1", params![id, stored]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        c.query_row(ATT_SQL_ONE, [id], att_row).map_err(|e| e.to_string())
    }
    pub fn attachments(&self, task_id: i64) -> Vec<crate::attachments::AttachmentRow> {
        let c = self.c();
        let mut st = c.prepare("SELECT id,task_id,project_id,name,kind,mime,size,stored,created_at FROM task_attachments WHERE task_id=?1 ORDER BY id").expect("sql");
        st.query_map([task_id], att_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn attachment(&self, id: i64) -> Option<crate::attachments::AttachmentRow> {
        self.c().query_row(ATT_SQL_ONE, [id], att_row).optional().ok().flatten()
    }
    pub fn delete_attachment(&self, id: i64) {
        let _ = self.c().execute("DELETE FROM task_attachments WHERE id=?1", [id]);
    }
    pub fn attachment_paths(&self) -> std::collections::HashSet<String> {
        let c = self.c();
        let mut st = c.prepare("SELECT stored FROM task_attachments").expect("sql");
        st.query_map([], |r| r.get::<_, String>(0)).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    // ---- library metadata (documents are always read from disk; this only remembers what the shelves showed)
    pub fn remember_library(&self, project_id: i64, docs: &[LibraryMeta]) {
        let c = self.c();
        let _ = c.execute("DELETE FROM library_docs WHERE project_id=?1", [project_id]);
        for d in docs {
            let _ = c.execute("INSERT OR REPLACE INTO library_docs(project_id,path,title,size,modified,seen_at) VALUES(?1,?2,?3,?4,?5,?6)", params![project_id, d.path, d.title, d.size, d.modified, now_ms()]);
        }
    }

    /// After a crash or forced exit: nothing can still be running, so reconcile stored state.
    pub fn recover_interrupted(&self) {
        let c = self.c();
        let _ = c.execute(
            "UPDATE executions SET status='failed', ended_at=?1, note='Interrupted: Mushoku Guild closed while this was running.' WHERE status='running'",
            [now_ms()],
        );
        let _ = c.execute("UPDATE tasks SET status='failed' WHERE status='running'", []);
        let _ = c.execute("UPDATE services SET status='ended', ended_at=?1 WHERE status='running'", [now_ms()]);
        let _ = c.execute("UPDATE chat_messages SET status='interrupted' WHERE status='streaming'", []);
        let _ = c.execute("UPDATE uchat_messages SET status='interrupted' WHERE status='streaming'", []);
        let _ = c.execute("UPDATE repo_research SET status=CASE WHEN report='' THEN 'failed' ELSE 'ready' END, note='Interrupted: Mushoku Guild closed during research.' WHERE status='researching'", []);
        let _ = c.execute(
            "UPDATE tasks SET status=CASE WHEN EXISTS(SELECT 1 FROM prompt_drafts d WHERE d.task_id=tasks.id) THEN 'prompt_ready' ELSE 'draft' END WHERE status='reasoning'",
            [],
        );
    }
}

const ATT_SQL_ONE: &str = "SELECT id,task_id,project_id,name,kind,mime,size,stored,created_at FROM task_attachments WHERE id=?1";
fn att_row(r: &rusqlite::Row) -> rusqlite::Result<crate::attachments::AttachmentRow> {
    Ok(crate::attachments::AttachmentRow { id: r.get(0)?, task_id: r.get(1)?, project_id: r.get(2)?, name: r.get(3)?, kind: r.get(4)?, mime: r.get(5)?, size: r.get(6)?, stored: r.get(7)?, created_at: r.get(8)? })
}
const TASK_SQL_ONE: &str = "SELECT id,project_id,title,description,status,created_at,updated_at FROM tasks WHERE id=?1";
const DRAFT_SQL_ONE: &str = "SELECT id,task_id,version,body,source,model,approved,created_at FROM prompt_drafts WHERE id=?1";

fn conv_row(r: &rusqlite::Row) -> rusqlite::Result<Conversation> {
    Ok(Conversation { id: r.get(0)?, project_id: r.get(1)?, title: r.get(2)?, updated_at: r.get(3)? })
}
fn msg_row(r: &rusqlite::Row) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage { id: r.get(0)?, conversation_id: r.get(1)?, role: r.get(2)?, body: r.get(3)?, created_at: r.get(4)?, kind: r.get(5)?, status: r.get(6)? })
}
fn project_row(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project { id: r.get(0)?, path: r.get(1)?, name: r.get(2)?, last_used_at: r.get(3)?, identity: r.get(4)? })
}
fn task_row(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task { id: r.get(0)?, project_id: r.get(1)?, title: r.get(2)?, description: r.get(3)?, status: r.get(4)?, created_at: r.get(5)?, updated_at: r.get(6)? })
}
fn draft_row(r: &rusqlite::Row) -> rusqlite::Result<Draft> {
    Ok(Draft {
        id: r.get(0)?,
        task_id: r.get(1)?,
        version: r.get(2)?,
        body: r.get(3)?,
        source: r.get(4)?,
        model: r.get(5)?,
        approved: r.get::<_, i64>(6)? != 0,
        created_at: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_allows_the_happy_path_and_rejects_shortcuts() {
        for (a, b) in [("draft", "reasoning"), ("reasoning", "prompt_ready"), ("prompt_ready", "approved"), ("approved", "running"), ("running", "completed"), ("completed", "accepted")] {
            assert!(transition_allowed(a, b), "{a}->{b}");
        }
        for (a, b) in [("draft", "running"), ("prompt_ready", "running"), ("accepted", "running"), ("running", "accepted"), ("draft", "approved")] {
            assert!(!transition_allowed(a, b), "{a}->{b} must be rejected");
        }
    }

    #[test]
    fn persistence_roundtrip_and_status_validation() {
        let db = Db::open_in_memory();
        let p = db.add_project("C:\\x\\proj", "proj").unwrap();
        let t = db.create_task(p.id, "t", "do a thing").unwrap();
        assert_eq!(t.status, "draft");
        assert!(db.set_status(t.id, "running").is_err());
        db.set_status(t.id, "reasoning").unwrap();
        let d = db.add_draft(t.id, "prompt", "reasoner", Some("m")).unwrap();
        assert_eq!(d.version, 1);
        db.set_status(t.id, "prompt_ready").unwrap();
        db.set_status(t.id, "approved").unwrap();
        let e = db.start_execution(t.id, d.id, "ask_each", "ask", "sonnet").unwrap();
        db.set_status(t.id, "running").unwrap();
        db.add_event(e, 1, "info", "hello", "");
        db.recover_interrupted();
        assert_eq!(db.task(t.id).unwrap().status, "failed");
        assert_eq!(db.executions(t.id)[0].status, "failed");
        assert_eq!(db.events_for_latest_execution(t.id).len(), 1);
    }

    #[test]
    fn terminal_state_is_written_once_and_exit_code_is_kept() {
        let db = Db::open_in_memory();
        let p = db.add_project("C:\\x", "x").unwrap();
        let t = db.create_task(p.id, "t", "d").unwrap();
        let d = db.add_draft(t.id, "p", "user", None).unwrap();
        let e = db.start_execution(t.id, d.id, "ask_each", "autopilot", "sonnet").unwrap();
        db.finish_execution(e, "completed", Some("ok"), Some(3), 0, None, Some(0));
        db.finish_execution(e, "failed", None, None, 0, Some("late duplicate"), Some(1));
        let ex = &db.executions(t.id)[0];
        assert_eq!((ex.status.as_str(), ex.exit_code, ex.permission_mode.as_str()), ("completed", Some(0), "autopilot"));
    }

    #[test]
    fn chat_messages_persist_in_order_with_kind_and_status() {
        let db = Db::open_in_memory();
        let p = db.add_project("C:\\x", "x").unwrap();
        assert!(db.latest_conversation(p.id).is_none());
        let c = db.create_conversation(p.id).unwrap();
        db.add_chat_message(c.id, "user", "Is this well architected?").unwrap();
        let a = db.add_chat_message_kind(c.id, "assistant", "", "text", "streaming").unwrap();
        db.update_chat_message(a.id, "Let me look.", "streaming");
        db.add_chat_message_kind(c.id, "agent", "findings", "agent", "complete").unwrap();
        db.recover_interrupted();
        let msgs = db.chat_messages(c.id);
        assert_eq!(msgs.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(), ["user", "assistant", "agent"]);
        assert_eq!((msgs[1].status.as_str(), msgs[1].body.as_str()), ("interrupted", "Let me look."), "a stream cut short keeps its partial text");
        assert_eq!(msgs[2].kind, "agent");
        let c2 = db.create_conversation(p.id).unwrap();
        assert_eq!(db.latest_conversation(p.id).unwrap().id, c2.id);
        assert_eq!(db.chat_messages(c.id).len(), 3, "the old conversation is kept");
    }

    #[test]
    fn conversations_are_isolated_per_repository_searchable_renamable_and_deletable() {
        let db = Db::open_in_memory();
        let a = db.add_project("C:\\a", "a").unwrap();
        let b = db.add_project("C:\\b", "b").unwrap();
        let ca = db.create_conversation(a.id).unwrap();
        db.add_chat_message(ca.id, "user", "How does authentication work?").unwrap();
        db.add_chat_message(ca.id, "assistant", "It uses JWT tokens.").unwrap();
        let cb = db.create_conversation(b.id).unwrap();
        db.add_chat_message(cb.id, "user", "Payments question").unwrap();
        assert_eq!(db.conversations(a.id, "").iter().map(|c| c.id).collect::<Vec<_>>(), vec![ca.id]);
        assert_eq!(db.conversations(b.id, "").iter().map(|c| c.id).collect::<Vec<_>>(), vec![cb.id]);
        assert_eq!(db.conversations(a.id, "jwt").len(), 1, "search finds message content");
        assert_eq!(db.conversations(a.id, "payments").len(), 0, "search never crosses repositories");
        db.rename_conversation(ca.id, "Auth deep dive");
        assert_eq!(db.conversations(a.id, "deep dive")[0].title, "Auth deep dive");
        db.delete_conversation(ca.id);
        assert!(db.chat_messages(ca.id).is_empty());
        assert_eq!(db.conversations(b.id, "").len(), 1);
    }

    #[test]
    fn quest_history_is_scoped_to_the_repository_and_carries_model_mode_and_summary() {
        let db = Db::open_in_memory();
        let a = db.add_project("C:\\a", "a").unwrap();
        let b = db.add_project("C:\\b", "b").unwrap();
        let ta = db.create_task(a.id, "Fix login", "d").unwrap();
        let tb = db.create_task(b.id, "Other repo quest", "d").unwrap();
        let d = db.add_draft(ta.id, "p", "user", None).unwrap();
        let e = db.start_execution(ta.id, d.id, "ask_each", "autopilot", "haiku").unwrap();
        db.finish_execution(e, "completed", Some("Login fixed"), Some(2), 0, None, Some(0));
        let ha = db.quest_history(a.id);
        assert_eq!(ha.len(), 1);
        assert_eq!((ha[0].title.as_str(), ha[0].model.as_str(), ha[0].permission_mode.as_str(), ha[0].summary.as_str()), ("Fix login", "haiku", "autopilot", "Login fixed"));
        assert_eq!(db.quest_history(b.id)[0].id, tb.id);
    }

    #[test]
    fn permission_preferences_persist_per_repository_and_can_be_revoked() {
        let db = Db::open_in_memory();
        let a = db.add_project("C:\\a", "a").unwrap();
        let b = db.add_project("C:\\b", "b").unwrap();
        assert!(db.repo_prefs(a.id).is_none());
        db.save_repo_prefs(a.id, true, "accept_edits", false, "git:abc", "C:\\a").unwrap();
        let p = db.repo_prefs(a.id).unwrap();
        assert_eq!((p.trusted, p.policy.as_str(), p.trusted_identity.as_str()), (true, "accept_edits", "git:abc"));
        assert!(db.repo_prefs(b.id).is_none(), "another repository inherits nothing");
        db.revoke_repo_prefs(a.id);
        assert!(db.repo_prefs(a.id).is_none());
    }

    #[test]
    fn moved_repository_keeps_its_data_when_relinked_by_identity() {
        let db = Db::open_in_memory();
        let a = db.add_project_with_identity("C:\\old\\proj", "proj", "git:root1").unwrap();
        let t = db.create_task(a.id, "t", "d").unwrap();
        let found = db.project_by_identity("git:root1").unwrap();
        db.relink_project(found.id, "D:\\new\\proj2", "proj2", "git:root1").unwrap();
        let p = db.project(a.id).unwrap();
        assert_eq!((p.path.as_str(), p.name.as_str()), ("D:\\new\\proj2", "proj2"));
        assert_eq!(db.tasks(a.id)[0].id, t.id);
        assert!(db.project_by_identity("").is_none());
    }

    #[test]
    fn services_belong_to_the_quest_and_are_closed_after_a_restart() {
        let db = Db::open_in_memory();
        let p = db.add_project("C:\\a", "a").unwrap();
        let t = db.create_task(p.id, "t", "d").unwrap();
        let id = db.add_service(t.id, "url", "http://localhost:3000", Some("http://localhost:3000"), None);
        assert!(db.has_url_service(t.id, "http://localhost:3000"));
        db.recover_interrupted();
        assert_eq!(db.service(id).unwrap().status, "ended");
    }

    #[test]
    fn failed_research_keeps_the_previous_report() {
        let db = Db::open_in_memory();
        let p = db.add_project("C:\\x", "x").unwrap();
        db.research_started(p.id);
        db.research_finished(p.id, "ready", Some("# Report"), &["src/a.rs".into()], "fp1", None);
        db.research_started(p.id);
        db.research_finished(p.id, "failed", None, &[], "fp2", Some("boom"));
        let r = db.research(p.id).unwrap();
        assert_eq!((r.status.as_str(), r.report.as_str(), r.fingerprint.as_str()), ("failed", "# Report", "fp1"));
        assert_eq!(r.files, vec!["src/a.rs".to_string()]);
    }

    #[test]
    fn same_project_path_is_not_duplicated() {
        let db = Db::open_in_memory();
        let a = db.add_project("C:\\p", "p").unwrap();
        let b = db.add_project("C:\\p", "p").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(db.projects().len(), 1);
    }
}
