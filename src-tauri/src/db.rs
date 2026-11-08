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

    fn c(&self) -> std::sync::MutexGuard<'_, Connection> {
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
    pub fn add_project(&self, path: &str, name: &str) -> Result<Project, String> {
        let now = now_ms();
        let c = self.c();
        c.execute(
            "INSERT INTO projects(path,name,created_at,last_used_at) VALUES(?1,?2,?3,?3)
             ON CONFLICT(path) DO UPDATE SET last_used_at=excluded.last_used_at",
            params![path, name, now],
        )
        .map_err(|e| e.to_string())?;
        c.query_row("SELECT id,path,name,last_used_at FROM projects WHERE path=?1", [path], project_row).map_err(|e| e.to_string())
    }
    pub fn projects(&self) -> Vec<Project> {
        let c = self.c();
        let mut st = c.prepare("SELECT id,path,name,last_used_at FROM projects ORDER BY last_used_at DESC").expect("sql");
        st.query_map([], project_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn project(&self, id: i64) -> Option<Project> {
        self.c().query_row("SELECT id,path,name,last_used_at FROM projects WHERE id=?1", [id], project_row).optional().ok().flatten()
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
    pub fn start_execution(&self, task_id: i64, draft_id: i64, policy: &str, permission_mode: &str) -> Result<i64, String> {
        let c = self.c();
        c.execute(
            "INSERT INTO executions(task_id,prompt_draft_id,policy,status,started_at,permission_mode) VALUES(?1,?2,?3,'running',?4,?5)",
            params![task_id, draft_id, policy, now_ms(), permission_mode],
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
            .prepare("SELECT id,task_id,policy,status,started_at,ended_at,result_text,num_turns,denial_count,note,exit_code,permission_mode FROM executions WHERE task_id=?1 ORDER BY id")
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
        let mut st = c.prepare("SELECT id,conversation_id,role,body,created_at FROM chat_messages WHERE conversation_id=?1 ORDER BY id").expect("sql");
        st.query_map([conversation_id], msg_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn add_chat_message(&self, conversation_id: i64, role: &str, body: &str) -> Result<ChatMessage, String> {
        let now = now_ms();
        let c = self.c();
        c.execute("INSERT INTO chat_messages(conversation_id,role,body,created_at) VALUES(?1,?2,?3,?4)", params![conversation_id, role, body, now]).map_err(|e| e.to_string())?;
        let id = c.last_insert_rowid();
        // the first user message names the conversation
        let _ = c.execute(
            "UPDATE chat_conversations SET updated_at=?2, title=CASE WHEN title='New conversation' AND ?3='user' THEN substr(?4,1,60) ELSE title END WHERE id=?1",
            params![conversation_id, now, role, body],
        );
        c.query_row("SELECT id,conversation_id,role,body,created_at FROM chat_messages WHERE id=?1", [id], msg_row).map_err(|e| e.to_string())
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

    /// After a crash or forced exit: nothing can still be running, so reconcile stored state.
    pub fn recover_interrupted(&self) {
        let c = self.c();
        let _ = c.execute(
            "UPDATE executions SET status='failed', ended_at=?1, note='Interrupted: Mushoku Guild closed while this was running.' WHERE status='running'",
            [now_ms()],
        );
        let _ = c.execute("UPDATE tasks SET status='failed' WHERE status='running'", []);
        let _ = c.execute("UPDATE repo_research SET status=CASE WHEN report='' THEN 'failed' ELSE 'ready' END, note='Interrupted: Mushoku Guild closed during research.' WHERE status='researching'", []);
        let _ = c.execute(
            "UPDATE tasks SET status=CASE WHEN EXISTS(SELECT 1 FROM prompt_drafts d WHERE d.task_id=tasks.id) THEN 'prompt_ready' ELSE 'draft' END WHERE status='reasoning'",
            [],
        );
    }
}

const TASK_SQL_ONE: &str = "SELECT id,project_id,title,description,status,created_at,updated_at FROM tasks WHERE id=?1";
const DRAFT_SQL_ONE: &str = "SELECT id,task_id,version,body,source,model,approved,created_at FROM prompt_drafts WHERE id=?1";

fn conv_row(r: &rusqlite::Row) -> rusqlite::Result<Conversation> {
    Ok(Conversation { id: r.get(0)?, project_id: r.get(1)?, title: r.get(2)?, updated_at: r.get(3)? })
}
fn msg_row(r: &rusqlite::Row) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage { id: r.get(0)?, conversation_id: r.get(1)?, role: r.get(2)?, body: r.get(3)?, created_at: r.get(4)? })
}
fn project_row(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project { id: r.get(0)?, path: r.get(1)?, name: r.get(2)?, last_used_at: r.get(3)? })
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
        let e = db.start_execution(t.id, d.id, "ask_each", "ask").unwrap();
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
        let e = db.start_execution(t.id, d.id, "ask_each", "autopilot").unwrap();
        db.finish_execution(e, "completed", Some("ok"), Some(3), 0, None, Some(0));
        db.finish_execution(e, "failed", None, None, 0, Some("late duplicate"), Some(1));
        let ex = &db.executions(t.id)[0];
        assert_eq!((ex.status.as_str(), ex.exit_code, ex.permission_mode.as_str()), ("completed", Some(0), "autopilot"));
    }

    #[test]
    fn chat_messages_persist_in_order_and_name_the_conversation() {
        let db = Db::open_in_memory();
        let p = db.add_project("C:\\x", "x").unwrap();
        assert!(db.latest_conversation(p.id).is_none());
        let c = db.create_conversation(p.id).unwrap();
        db.add_chat_message(c.id, "user", "Is this well architected?").unwrap();
        db.add_chat_message(c.id, "assistant", "Let me look.").unwrap();
        let msgs = db.chat_messages(c.id);
        assert_eq!(msgs.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(), ["user", "assistant"]);
        assert_eq!(db.latest_conversation(p.id).unwrap().title, "Is this well architected?");
        let c2 = db.create_conversation(p.id).unwrap();
        assert_eq!(db.latest_conversation(p.id).unwrap().id, c2.id);
        assert_eq!(db.chat_messages(c.id).len(), 2, "the old conversation is kept");
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
