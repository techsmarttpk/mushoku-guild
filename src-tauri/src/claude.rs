//! Claude Code "Executor": detects the user's own native `claude.exe` and runs it as a child process in
//! print mode with stream-json in/out. Mushoku Guild never reads Claude credentials; the CLI authenticates
//! itself with the user's existing login. Event shapes below were OBSERVED on CLI 2.1.319 (`docs/context.md`
//! §13) and are not an official schema, so parsing is defensive and unknown events are ignored.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::db::Db;
use crate::events::{emit, hidden, truncate, Activity, AppEvent};

const MIN_TESTED: (u32, u32) = (2, 1);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);
const GRACE_AFTER_INTERRUPT: Duration = Duration::from_secs(4);

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub signer: Option<String>,
    pub signature_valid: bool,
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------- detection

pub fn locate(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path.filter(|p| !p.trim().is_empty()) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("claude.exe");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    let home = std::env::var_os("USERPROFILE")?;
    let c = PathBuf::from(home).join(".local").join("bin").join("claude.exe");
    c.is_file().then_some(c)
}

/// Runs a short command and returns stdout, killing it after `limit`.
pub fn capture(mut cmd: Command, limit: Duration) -> Option<(i32, String)> {
    hidden(&mut cmd);
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Some((st.code().unwrap_or(-1), reader.join().unwrap_or_default())),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let tok = s.split_whitespace().next()?;
    let mut it = tok.split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

pub fn detect(override_path: Option<&str>) -> ClaudeInfo {
    let mut info = ClaudeInfo::default();
    let Some(exe) = locate(override_path) else {
        info.error = Some("Claude Code (claude.exe) was not found. Install the native Windows version from Anthropic, or choose claude.exe manually.".into());
        return info;
    };
    info.path = Some(exe.display().to_string());
    let mut v = Command::new(&exe);
    v.arg("--version");
    match capture(v, Duration::from_secs(20)) {
        Some((0, out)) => {
            info.version = Some(out.trim().to_string());
            match parse_version(&out) {
                Some((a, b, _)) if (a, b) < MIN_TESTED => info.warnings.push(format!(
                    "This Claude Code version is older than the tested {}.{}.x; streaming and permission behaviour may differ. Update with `claude update`.",
                    MIN_TESTED.0, MIN_TESTED.1
                )),
                None => info.warnings.push("Could not read the Claude Code version.".into()),
                _ => {}
            }
        }
        _ => {
            info.error = Some("claude.exe did not answer `--version`.".into());
            return info;
        }
    }
    // Authenticode check: confirms the file is the unmodified signed binary (path passed through the environment).
    let mut ps = Command::new("powershell");
    ps.args(["-NoProfile", "-NonInteractive", "-Command", "$s=Get-AuthenticodeSignature -LiteralPath $env:MG_EXE; \"$($s.Status)|$($s.SignerCertificate.Subject)\""])
        .env("MG_EXE", &exe);
    if let Some((_, out)) = capture(ps, Duration::from_secs(30)) {
        let out = out.trim();
        if let Some((status, subject)) = out.split_once('|') {
            info.signature_valid = status == "Valid";
            info.signer = subject.split("CN=").nth(1).map(|s| s.trim_matches(|c| c == '"' || c == ',').split(',').next().unwrap_or("").trim_matches('"').to_string());
            if !info.signature_valid {
                info.warnings.push(format!("claude.exe signature status is '{status}', not 'Valid'."));
            }
        }
    }
    let mut a = Command::new(&exe);
    a.args(["auth", "status"]).envs(clean_env_pairs());
    match capture(a, Duration::from_secs(30)) {
        Some((_, out)) => match serde_json::from_str::<Value>(out.trim()) {
            Ok(j) => {
                info.logged_in = j["loggedIn"].as_bool();
                info.auth_method = j["authMethod"].as_str().map(String::from);
            }
            Err(_) => info.warnings.push("Could not read `claude auth status`.".into()),
        },
        None => info.warnings.push("`claude auth status` did not answer.".into()),
    }
    if info.logged_in == Some(false) {
        info.error = Some("Claude Code is not signed in. Open a terminal, run `claude`, and sign in; then check again.".into());
    }
    for k in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
        if std::env::var_os(k).is_some() {
            info.warnings.push(format!("{k} is set in your environment. Mushoku Guild removes it for the child process so your subscription login is used, not API billing."));
        }
    }
    info
}

// ---------------------------------------------------------------- environment

fn is_session_var(k: &str) -> bool {
    let k = k.to_ascii_uppercase();
    (k.starts_with("CLAUDE_CODE_") && k != "CLAUDE_CODE_OAUTH_TOKEN")
        || k == "CLAUDECODE"
        || k == "CLAUDE_PID"
        || k == "CLAUDE_EFFORT"
        || k.starts_with("CLAUDE_AGENT")
        || k == "AI_AGENT"
        || k == "ANTHROPIC_API_KEY"
        || k == "ANTHROPIC_AUTH_TOKEN"
}

/// The parent environment minus inherited Claude session variables and API-billing credentials.
pub fn clean_env_pairs() -> Vec<(String, String)> {
    std::env::vars().filter(|(k, _)| !is_session_var(k)).collect()
}

// ---------------------------------------------------------------- model selection

/// Models offered in the UI. Claude Code stays the authority on what the account may use.
pub const MODEL_CHOICES: [&str; 4] = ["sonnet", "opus", "haiku", "default"];
pub const DEFAULT_MODEL: &str = "sonnet";

/// Maps the stored setting to the `--model` value. None = "CLI default": no override is passed.
/// Unset or unrecognised values fall back to Sonnet (never silently to Opus).
pub fn resolve_model(setting: Option<&str>) -> Option<&'static str> {
    match setting.map(str::trim).filter(|s| !s.is_empty()) {
        None => Some(DEFAULT_MODEL),
        Some("default") => None,
        Some(s) => MODEL_CHOICES.iter().copied().find(|m| *m == s && *m != "default").or(Some(DEFAULT_MODEL)),
    }
}

// ---------------------------------------------------------------- policies

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Policy {
    ReadOnly,
    AskEach,
    AcceptEdits,
}

impl Policy {
    pub fn parse(s: &str) -> Option<Policy> {
        match s {
            "read_only" => Some(Policy::ReadOnly),
            "ask_each" => Some(Policy::AskEach),
            "accept_edits" => Some(Policy::AcceptEdits),
            _ => None,
        }
    }
    fn tools(self) -> &'static str {
        match self {
            Policy::ReadOnly => "Read,Glob,Grep",
            _ => "Read,Glob,Grep,Edit,Write,Bash",
        }
    }
}

/// Builds the CLI arguments. Pure so the security-relevant flags can be tested.
pub fn build_args(policy: Policy, mcp_config: &Path, model: &str, max_turns: u32) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
        "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "project,local",
        "--permission-prompt-tool", "mcp__mushoku__approve",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push("--mcp-config".into());
    a.push(mcp_config.display().to_string());
    a.push("--tools".into());
    a.push(policy.tools().into());
    if policy == Policy::AcceptEdits {
        a.push("--permission-mode".into());
        a.push("acceptEdits".into());
    }
    if !model.trim().is_empty() {
        a.push("--model".into());
        a.push(model.trim().to_string());
    }
    a.push("--max-turns".into());
    a.push(max_turns.to_string());
    a
}

// ---------------------------------------------------------------- event normalisation

pub struct Norm {
    pub kind: &'static str,
    pub title: String,
    pub detail: String,
}

fn summarize_input(tool: &str, input: &Value) -> String {
    let pick = |k: &str| input[k].as_str().map(String::from);
    let s = match tool {
        "Bash" => pick("command"),
        "Read" | "Write" | "Edit" | "NotebookEdit" => pick("file_path"),
        "Glob" | "Grep" => pick("pattern"),
        _ => None,
    };
    truncate(&s.unwrap_or_else(|| input.to_string()), 600)
}

fn tool_result_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

pub fn normalize(ev: &Value, tools: &mut HashMap<String, String>) -> Vec<Norm> {
    let mut out = Vec::new();
    match (ev["type"].as_str().unwrap_or(""), ev["subtype"].as_str().unwrap_or("")) {
        ("system", "init") => {
            let mcp: Vec<String> = ev["mcp_servers"].as_array().map(|a| a.iter().map(|m| format!("{}:{}", m["name"].as_str().unwrap_or("?"), m["status"].as_str().unwrap_or("?"))).collect()).unwrap_or_default();
            out.push(Norm {
                kind: "init",
                title: "Claude Code started".into(),
                detail: format!("model {} · CLI {} · permission mode {} · approver {}", ev["model"].as_str().unwrap_or("?"), ev["claude_code_version"].as_str().unwrap_or("?"), ev["permissionMode"].as_str().unwrap_or("?"), mcp.join(", ")),
            });
        }
        ("system", "permission_denied") => out.push(Norm {
            kind: "permission_denied",
            title: format!("Denied: {}", ev["tool_name"].as_str().unwrap_or("tool")),
            detail: truncate(ev["message"].as_str().unwrap_or(""), 800),
        }),
        ("assistant", _) => {
            if let Some(blocks) = ev["message"]["content"].as_array() {
                for b in blocks {
                    match b["type"].as_str().unwrap_or("") {
                        "text" => {
                            let t = b["text"].as_str().unwrap_or("").trim();
                            if !t.is_empty() {
                                out.push(Norm { kind: "assistant_text", title: "Claude".into(), detail: truncate(t, 4000) });
                            }
                        }
                        "tool_use" => {
                            let name = b["name"].as_str().unwrap_or("tool").to_string();
                            if let Some(id) = b["id"].as_str() {
                                tools.insert(id.to_string(), name.clone());
                            }
                            out.push(Norm { kind: "tool_use", title: name.clone(), detail: summarize_input(&name, &b["input"]) });
                        }
                        _ => {}
                    }
                }
            }
        }
        ("user", _) => {
            if let Some(blocks) = ev["message"]["content"].as_array() {
                for b in blocks.iter().filter(|b| b["type"] == "tool_result") {
                    let name = b["tool_use_id"].as_str().and_then(|id| tools.get(id)).cloned().unwrap_or_else(|| "tool".into());
                    let is_err = b["is_error"].as_bool().unwrap_or(false);
                    out.push(Norm {
                        kind: if is_err { "tool_error" } else { "tool_result" },
                        title: if is_err { format!("{name} reported an error") } else { format!("{name} finished") },
                        detail: truncate(&tool_result_text(&b["content"]), 2000),
                    });
                }
            }
        }
        _ => {}
    }
    out
}

/// (status, note) for the finished process. A permission denial is not a failure; an error `result` is.
pub fn final_status(cancelled: bool, result: Option<&Value>) -> (&'static str, Option<String>) {
    if cancelled {
        return ("cancelled", Some("Cancelled by the user.".into()));
    }
    match result {
        None => ("failed", Some("Claude Code ended without producing a result.".into())),
        Some(r) => {
            if r["is_error"].as_bool().unwrap_or(false) {
                let text = r["result"].as_str().unwrap_or("");
                let status = r["api_error_status"].as_i64().unwrap_or(0);
                let hint = if status == 401 || status == 403 || text.to_lowercase().contains("/login") {
                    "Claude Code is not signed in or the login expired. Run `claude` in a terminal and sign in."
                } else if status == 429 || text.to_lowercase().contains("limit") {
                    "Claude usage limit reached. Wait for the reset shown in Claude Code, then retry."
                } else if r["subtype"] == "error_max_turns" {
                    "Claude stopped after reaching the maximum number of turns."
                } else {
                    "Claude Code reported an error."
                };
                ("failed", Some(format!("{hint} {}", truncate(text, 600)).trim().to_string()))
            } else {
                ("completed", None)
            }
        }
    }
}

// ---------------------------------------------------------------- Windows job object (reliable tree cleanup)

pub struct Job(usize);

impl Job {
    /// A job whose processes are all killed when it is closed or when Mushoku Guild dies.
    pub fn new() -> Option<Job> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32);
            if ok == 0 {
                windows_sys::Win32::Foundation::CloseHandle(h);
                return None;
            }
            Some(Job(h as usize))
        }
    }
    pub fn assign(&self, process: std::os::windows::io::RawHandle) -> bool {
        unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0 as _, process as _) != 0 }
    }
    pub fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0 as _, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

pub fn kill_tree(pid: u32) {
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
    let _ = hidden(&mut c).status();
}

// ---------------------------------------------------------------- runner

type Decision = (bool, String); // (allow, decided_by)

#[derive(Default)]
struct Pending(Mutex<HashMap<String, Sender<Decision>>>);

struct Active {
    task_id: i64,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    cancel: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    pending: Arc<Pending>,
    job: Arc<Option<Job>>,
    pid: u32,
}

#[derive(Default)]
pub struct Runner {
    active: Mutex<Option<Active>>,
}

struct RunCtx {
    app: AppHandle,
    db: Arc<Db>,
    task_id: i64,
    exec_id: i64,
    seq: AtomicI64,
}

impl RunCtx {
    fn push(&self, kind: &str, title: &str, detail: &str) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.db.add_event(self.exec_id, seq, kind, title, detail);
        emit(
            &self.app,
            AppEvent::RunActivity {
                task_id: self.task_id,
                activity: Activity { seq, ts: crate::db::now_ms(), kind: kind.into(), title: title.into(), detail: detail.into() },
            },
        );
    }
}

pub struct StartRequest {
    pub app: AppHandle,
    pub db: Arc<Db>,
    pub exe: PathBuf,
    pub project_dir: PathBuf,
    pub task_id: i64,
    pub exec_id: i64,
    pub prompt: String,
    pub policy: Policy,
    pub model: String,
    pub max_turns: u32,
    pub data_dir: PathBuf,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl Runner {
    pub fn is_running(&self) -> bool {
        self.active.lock().unwrap_or_else(|p| p.into_inner()).is_some()
    }

    pub fn start(self: &Arc<Self>, req: StartRequest) -> Result<(), String> {
        let mut slot = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_some() {
            return Err("Another execution is already running (the MVP allows one at a time).".into());
        }
        if !req.project_dir.is_dir() {
            return Err(format!("The project folder no longer exists: {}", req.project_dir.display()));
        }
        // Approval channel: the child's MCP approver (this same executable) connects back over loopback.
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("cannot open the approval channel: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = random_hex(24);
        std::fs::create_dir_all(&req.data_dir).map_err(|e| e.to_string())?;
        let cfg_path = req.data_dir.join(format!("run-{}.mcp.json", req.exec_id));
        let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let cfg = json!({"mcpServers": {"mushoku": {
            "command": self_exe.display().to_string(), "args": ["--mcp-approver"],
            "env": {"MUSHOKU_APPROVER_ADDR": format!("127.0.0.1:{port}"), "MUSHOKU_APPROVER_TOKEN": token}
        }}});
        std::fs::write(&cfg_path, cfg.to_string()).map_err(|e| e.to_string())?;

        let args = build_args(req.policy, &cfg_path, &req.model, req.max_turns);
        let mut cmd = Command::new(&req.exe);
        cmd.args(&args).current_dir(&req.project_dir).env_clear().envs(clean_env_pairs()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        hidden(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| {
            let _ = std::fs::remove_file(&cfg_path);
            format!("could not start Claude Code: {e}")
        })?;
        let pid = child.id();
        let job = Job::new();
        let job_ok = job.as_ref().map(|j| {
            use std::os::windows::io::AsRawHandle;
            j.assign(child.as_raw_handle())
        });
        let job = Arc::new(job.filter(|_| job_ok == Some(true)));

        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let msg = json!({"type": "user", "message": {"role": "user", "content": req.prompt}});
        stdin.write_all(format!("{msg}\n").as_bytes()).map_err(|e| format!("could not send the prompt: {e}"))?;
        let stdin = Arc::new(Mutex::new(Some(stdin)));
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let cancel = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let pending = Arc::new(Pending::default());
        *slot = Some(Active { task_id: req.task_id, stdin: stdin.clone(), cancel: cancel.clone(), exited: exited.clone(), pending: pending.clone(), job: job.clone(), pid });
        drop(slot);

        let ctx = Arc::new(RunCtx { app: req.app.clone(), db: req.db.clone(), task_id: req.task_id, exec_id: req.exec_id, seq: AtomicI64::new(0) });
        if job.is_none() {
            ctx.push("info", "Process cleanup", "Windows job object unavailable; falling back to taskkill for cleanup.");
        }
        emit(&req.app, AppEvent::RunStarted { task_id: req.task_id, execution_id: req.exec_id });

        // approval server
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (ctx, pending, token, stop, policy) = (ctx.clone(), pending.clone(), token.clone(), stop.clone(), req.policy);
            std::thread::spawn(move || serve_approvals(listener, ctx, pending, token, stop, policy));
        }
        // stderr tail
        let err_tail = Arc::new(Mutex::new(String::new()));
        {
            let tail = err_tail.clone();
            std::thread::spawn(move || {
                let mut r = BufReader::new(stderr);
                let mut line = String::new();
                while r.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                    let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
                    t.push_str(&line);
                    if t.len() > 4000 {
                        let cut = t.len() - 4000;
                        *t = t[t.char_indices().find(|(i, _)| *i >= cut).map(|(i, _)| i).unwrap_or(0)..].to_string();
                    }
                    line.clear();
                }
            });
        }
        // stdout reader
        let (done_tx, done_rx) = channel::<(Option<Value>, i64)>();
        {
            let (ctx, stdin) = (ctx.clone(), stdin.clone());
            std::thread::spawn(move || read_stream(stdout, ctx, stdin, done_tx));
        }
        // supervisor
        let me = self.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            exited.store(true, Ordering::SeqCst);
            if let Some(j) = job.as_ref() {
                j.terminate(); // sweep anything the tool calls left behind
            }
            let (result, denials) = done_rx.recv_timeout(Duration::from_secs(5)).unwrap_or((None, 0));
            stop.store(true, Ordering::SeqCst);
            pending.deny_all("run ended");
            let _ = std::fs::remove_file(&cfg_path);
            let was_cancelled = cancel.load(Ordering::SeqCst);
            let (mut status, mut note) = final_status(was_cancelled, result.as_ref());
            if result.is_none() && !was_cancelled {
                let tail = err_tail.lock().unwrap_or_else(|p| p.into_inner()).trim().to_string();
                if !tail.is_empty() {
                    note = Some(format!("Claude Code ended without a result. Its error output: {}", truncate(&tail, 600)));
                }
            }
            if result.as_ref().map(|r| r["is_error"].as_bool().unwrap_or(false)) == Some(false) && !was_cancelled {
                status = "completed";
            }
            let result_text = result.as_ref().and_then(|r| r["result"].as_str()).map(String::from);
            let turns = result.as_ref().and_then(|r| r["num_turns"].as_i64());
            ctx.push(
                if status == "completed" { "result" } else if status == "cancelled" { "cancelled" } else { "error" },
                match status {
                    "completed" => "Execution completed",
                    "cancelled" => "Execution cancelled",
                    _ => "Execution failed",
                },
                note.as_deref().or(result_text.as_deref()).unwrap_or(""),
            );
            ctx.db.finish_execution(ctx.exec_id, status, result_text.as_deref(), turns, denials, note.as_deref());
            let _ = ctx.db.set_status(ctx.task_id, status);
            *me.active.lock().unwrap_or_else(|p| p.into_inner()) = None;
            emit(&ctx.app, AppEvent::TaskStatus { task_id: ctx.task_id, status: status.into() });
            emit(&ctx.app, AppEvent::RunFinished { task_id: ctx.task_id, status: status.into(), result: result_text, note });
        });
        Ok(())
    }

    /// Graceful interrupt first; force-terminate the whole process tree if it does not exit in time.
    pub fn cancel(&self) -> bool {
        let guard = self.active.lock().unwrap_or_else(|p| p.into_inner());
        let Some(a) = guard.as_ref() else { return false };
        a.cancel.store(true, Ordering::SeqCst);
        a.pending.deny_all("cancelled");
        {
            let mut si = a.stdin.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(s) = si.as_mut() {
                let m = json!({"type": "control_request", "request_id": format!("mg-{}", random_hex(4)), "request": {"subtype": "interrupt"}});
                let _ = s.write_all(format!("{m}\n").as_bytes());
                let _ = s.flush();
            }
        }
        let (exited, stdin, job, pid) = (a.exited.clone(), a.stdin.clone(), a.job.clone(), a.pid);
        std::thread::spawn(move || {
            let start = Instant::now();
            while !exited.load(Ordering::SeqCst) && start.elapsed() < GRACE_AFTER_INTERRUPT {
                std::thread::sleep(Duration::from_millis(100));
            }
            *stdin.lock().unwrap_or_else(|p| p.into_inner()) = None; // closing stdin lets a graceful exit finish
            std::thread::sleep(Duration::from_millis(500));
            if !exited.load(Ordering::SeqCst) {
                match job.as_ref() {
                    Some(j) => j.terminate(),
                    None => kill_tree(pid),
                }
            }
        });
        true
    }

    pub fn decide(&self, request_id: &str, allow: bool) -> bool {
        let guard = self.active.lock().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().map(|a| a.pending.resolve(request_id, allow, "user")).unwrap_or(false)
    }

    pub fn active_task(&self) -> Option<i64> {
        self.active.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|a| a.task_id)
    }

    /// Called when the app is closing: nothing may outlive Mushoku Guild.
    pub fn shutdown(&self) {
        if let Some(a) = self.active.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            a.cancel.store(true, Ordering::SeqCst);
            match a.job.as_ref() {
                Some(j) => j.terminate(),
                None => kill_tree(a.pid),
            }
        }
    }
}

impl Pending {
    fn deny_all(&self, by: &str) {
        let map: Vec<_> = self.0.lock().unwrap_or_else(|p| p.into_inner()).drain().collect();
        for (_, tx) in map {
            let _ = tx.send((false, by.into()));
        }
    }
    fn resolve(&self, id: &str, allow: bool, by: &str) -> bool {
        match self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(id) {
            Some(tx) => tx.send((allow, by.into())).is_ok(),
            None => false,
        }
    }
}

fn read_stream(stdout: std::process::ChildStdout, ctx: Arc<RunCtx>, stdin: Arc<Mutex<Option<ChildStdin>>>, done: Sender<(Option<Value>, i64)>) {
    let mut tools: HashMap<String, String> = HashMap::new();
    let mut result: Option<Value> = None;
    let mut denials = 0i64;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(ev) = serde_json::from_str::<Value>(line.trim()) else { continue };
        match (ev["type"].as_str().unwrap_or(""), ev["subtype"].as_str().unwrap_or("")) {
            ("rate_limit_event", _) => {
                let w = &ev["rate_limit_info"]["unifiedWindows"];
                emit(
                    &ctx.app,
                    AppEvent::ClaudeRate {
                        five_hour: w["five_hour"]["utilization"].as_f64(),
                        seven_day: w["seven_day"]["utilization"].as_f64(),
                        status: ev["rate_limit_info"]["status"].as_str().map(String::from),
                    },
                );
                if ev["rate_limit_info"]["status"].as_str().map(|s| s != "allowed").unwrap_or(false) {
                    ctx.push("rate_limit", "Claude usage limit warning", &truncate(&ev["rate_limit_info"].to_string(), 500));
                }
            }
            ("result", _) => {
                denials = ev["permission_denials"].as_array().map(|a| a.len() as i64).unwrap_or(0);
                result = Some(ev);
                *stdin.lock().unwrap_or_else(|p| p.into_inner()) = None; // done: closing stdin lets the CLI exit
            }
            _ => {
                for n in normalize(&ev, &mut tools) {
                    ctx.push(n.kind, &n.title, &n.detail);
                }
            }
        }
    }
    let _ = done.send((result, denials));
}

fn serve_approvals(listener: TcpListener, ctx: Arc<RunCtx>, pending: Arc<Pending>, token: String, stop: Arc<AtomicBool>, policy: Policy) {
    let _ = listener.set_nonblocking(true);
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((s, _)) => {
                let (ctx, pending, token) = (ctx.clone(), pending.clone(), token.clone());
                std::thread::spawn(move || handle_approval(s, ctx, pending, token, policy));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
}

fn handle_approval(mut s: TcpStream, ctx: Arc<RunCtx>, pending: Arc<Pending>, token: String, policy: Policy) {
    let _ = s.set_nonblocking(false);
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let mut line = String::new();
    if BufReader::new(&s).read_line(&mut line).is_err() {
        return;
    }
    let reply = |s: &mut TcpStream, allow: bool, input: &Value, msg: &str| {
        let d = if allow { json!({"behavior": "allow", "updatedInput": input}) } else { json!({"behavior": "deny", "message": msg}) };
        let _ = s.write_all(format!("{d}\n").as_bytes());
    };
    let Ok(req) = serde_json::from_str::<Value>(line.trim()) else { return };
    if req["token"].as_str() != Some(token.as_str()) {
        return; // not our approver
    }
    let tool = req["tool_name"].as_str().unwrap_or("tool").to_string();
    let input = req["input"].clone();
    let summary = summarize_input(&tool, &input);
    if policy == Policy::ReadOnly {
        ctx.db.add_approval(ctx.exec_id, &tool, &summary, "deny", "policy");
        ctx.push("permission_decision", &format!("Blocked by read-only policy: {tool}"), &summary);
        reply(&mut s, false, &input, "Denied: this run uses the read-only policy.");
        return;
    }
    let id = random_hex(8);
    let (tx, rx) = channel::<Decision>();
    pending.0.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), tx);
    ctx.push("permission_request", &format!("Permission needed: {tool}"), &summary);
    emit(&ctx.app, AppEvent::RunPermission { task_id: ctx.task_id, request_id: id.clone(), tool_name: tool.clone(), summary: summary.clone(), input: truncate(&serde_json::to_string_pretty(&input).unwrap_or_default(), 4000) });
    let (allow, by) = rx.recv_timeout(APPROVAL_TIMEOUT).unwrap_or_else(|_| {
        pending.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        (false, "timeout".into())
    });
    let decision = if allow { "allow" } else { "deny" };
    ctx.db.add_approval(ctx.exec_id, &tool, &summary, decision, &by);
    ctx.push("permission_decision", &format!("{} {tool}", if allow { "Allowed" } else { "Denied" }), &format!("{summary} (decided by {by})"));
    emit(&ctx.app, AppEvent::RunPermissionResolved { request_id: id, decision: decision.into() });
    reply(&mut s, allow, &input, &format!("Denied by the user in Mushoku Guild ({by})."));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_never_skip_permissions_and_always_pin_mcp_config() {
        for p in [Policy::ReadOnly, Policy::AskEach, Policy::AcceptEdits] {
            let a = build_args(p, Path::new("C:\\x\\cfg.json"), "", 30);
            assert!(!a.iter().any(|x| x.contains("dangerously")));
            assert!(a.contains(&"--strict-mcp-config".to_string()));
            assert!(a.contains(&"--permission-prompt-tool".to_string()));
            assert!(a.contains(&"--disable-slash-commands".to_string()));
        }
        let ro = build_args(Policy::ReadOnly, Path::new("c"), "", 5);
        assert!(ro.contains(&"Read,Glob,Grep".to_string()) && !ro.contains(&"--permission-mode".to_string()));
        let ae = build_args(Policy::AcceptEdits, Path::new("c"), "haiku", 5);
        assert!(ae.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]) && ae.windows(2).any(|w| w == ["--model", "haiku"]));
    }

    #[test]
    fn child_environment_drops_session_and_api_billing_variables() {
        for k in ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID", "AI_AGENT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
            assert!(is_session_var(k), "{k}");
        }
        for k in ["PATH", "USERPROFILE", "CLAUDE_CODE_OAUTH_TOKEN", "APPDATA"] {
            assert!(!is_session_var(k), "{k}");
        }
    }

    #[test]
    fn permission_denial_is_not_a_failure_but_error_result_is() {
        let ok = json!({"type":"result","subtype":"success","is_error":false,"permission_denials":["Write"],"result":"done"});
        assert_eq!(final_status(false, Some(&ok)).0, "completed");
        let bad = json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"});
        assert_eq!(final_status(false, Some(&bad)).0, "failed");
        assert_eq!(final_status(true, Some(&bad)).0, "cancelled");
        assert_eq!(final_status(false, None).0, "failed");
        let limit = json!({"is_error":true,"api_error_status":429,"result":"usage limit"});
        assert!(final_status(false, Some(&limit)).1.unwrap().contains("usage limit"));
    }

    #[test]
    fn normalizes_tool_use_and_results() {
        let mut tools = HashMap::new();
        let a = json!({"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}});
        let n = normalize(&a, &mut tools);
        assert_eq!(n.len(), 2);
        assert_eq!((n[1].kind, n[1].title.as_str(), n[1].detail.as_str()), ("tool_use", "Bash", "ls"));
        let u = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"nope"}]}});
        let r = normalize(&u, &mut tools);
        assert_eq!(r[0].kind, "tool_error");
        assert!(r[0].title.starts_with("Bash"));
        assert!(normalize(&json!({"type":"mystery"}), &mut tools).is_empty());
    }

    #[test]
    fn model_selection_defaults_to_sonnet_and_cli_default_passes_nothing() {
        assert_eq!(resolve_model(None), Some("sonnet"));
        assert_eq!(resolve_model(Some("")), Some("sonnet"));
        assert_eq!(resolve_model(Some("opus")), Some("opus"));
        assert_eq!(resolve_model(Some("haiku")), Some("haiku"));
        assert_eq!(resolve_model(Some("default")), None);
        assert_eq!(resolve_model(Some("claude-opus-5-5 --evil")), Some("sonnet"));
        let with = build_args(Policy::AskEach, Path::new("c"), resolve_model(Some("haiku")).unwrap_or(""), 5);
        assert!(with.windows(2).any(|w| w == ["--model", "haiku"]));
        let without = build_args(Policy::AskEach, Path::new("c"), resolve_model(Some("default")).unwrap_or(""), 5);
        assert!(!without.contains(&"--model".to_string()));
    }

    #[test]
    fn version_parse() {
        assert_eq!(parse_version("2.1.319 (Claude Code)"), Some((2, 1, 319)));
        assert_eq!(parse_version("garbage"), None);
    }
}
