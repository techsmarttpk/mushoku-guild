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
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::db::Db;
use crate::events::{emit, hidden, truncate, Activity, AppEvent};

const MIN_TESTED: (u32, u32) = (2, 1);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

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
    /// Repository research: read tools plus read-only git, nothing else.
    Research,
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
            Policy::Research => "Read,Glob,Grep,Bash",
            _ => "Read,Glob,Grep,Edit,Write,Bash",
        }
    }
}

/// Builds the CLI arguments. Pure so the security-relevant flags can be tested.
pub fn build_args(policy: Policy, mcp_config: &Path, model: &str, max_turns: u32) -> Vec<String> {
    build_args_chrome(policy, mcp_config, model, max_turns, false)
}

/// `chrome` adds the official `--chrome` flag (Claude in Chrome). It stays compatible with `--strict-mcp-config`:
/// Claude Code adds its own `claude-in-chrome` server as a dynamic source (verified on 2.1.319).
pub fn build_args_chrome(policy: Policy, mcp_config: &Path, model: &str, max_turns: u32, chrome: bool) -> Vec<String> {
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
    if !model.trim().is_empty() {
        a.push("--model".into());
        a.push(model.trim().to_string());
    }
    a.push("--max-turns".into());
    a.push(max_turns.to_string());
    if chrome {
        a.push("--chrome".into());
    }
    a
}

/// Names Claude must not read during research, enforced by Claude Code itself (in addition to our redaction).
pub const RESEARCH_DENY: &str = "Read(**/.env),Read(**/.env.*),Read(**/*.pem),Read(**/*.key),Read(**/*.p12),Read(**/*.pfx),Read(**/id_rsa*),Read(**/id_ed25519*),Read(**/*credential*),Read(**/*secret*),Read(**/.npmrc),Read(**/.netrc),Read(**/node_modules/**),Read(**/.git/**),Read(**/target/**),Read(**/dist/**)";

/// Research is strictly read-only: Read/Glob/Grep plus Bash that the approver only allows for read-only git
/// commands (hardened before they run); every other request is denied, and secret-looking paths are blocked by
/// deny rules.
pub fn research_args(mcp_config: &Path, model: &str, max_turns: u32) -> Vec<String> {
    let mut a = build_args(Policy::Research, mcp_config, model, max_turns);
    a.push("--disallowedTools".into());
    a.push(RESEARCH_DENY.into());
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
    if tool.starts_with("mcp__claude-in-chrome__") {
        return truncate(&format!("{} {}", crate::autopilot::browser_short(tool), input), 600);
    }
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
    /// Process ids currently inside the job (up to 256).
    pub fn pids(&self) -> Vec<u32> {
        use windows_sys::Win32::System::JobObjects::{JobObjectBasicProcessIdList, QueryInformationJobObject};
        let mut buf = vec![0u8; 8 + 8 * 256];
        let ok = unsafe { QueryInformationJobObject(self.0 as _, JobObjectBasicProcessIdList, buf.as_mut_ptr() as *mut _, buf.len() as u32, std::ptr::null_mut()) };
        if ok == 0 {
            return vec![];
        }
        let listed = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
        (0..listed.min(256))
            .map(|i| {
                let o = 8 + i * 8;
                u64::from_le_bytes(buf[o..o + 8].try_into().unwrap_or([0; 8])) as u32
            })
            .collect()
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

/// What a Claude run is for. Quests may edit under the user's policy; research is strictly read-only.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RunKind {
    Quest { task_id: i64, exec_id: i64 },
    Research { project_id: i64 },
    /// A focused research request from the chat adviser; the result goes back through a channel, not to the report.
    Probe { project_id: i64 },
}

/// Messages from the three watchers of one process (stdout reader, exit waiter) to its supervisor.
#[derive(Debug)]
pub enum RunMsg {
    /// The CLI printed its final `result` event (and how many permission denials it counted).
    Result(Value, i64),
    /// stdout closed without a result.
    StreamEnd,
    /// The process exited with this code (-1 when unknown).
    Exit(i32),
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub status: String,
    pub text: String,
    pub files: Vec<String>,
    pub note: Option<String>,
}

#[derive(Debug, Default)]
pub struct Resolved {
    pub result: Option<Value>,
    pub denials: i64,
    pub exit_code: Option<i32>,
    /// The process had to be killed because it did not exit after its result.
    pub forced: bool,
}

/// Decides the outcome of one run from the watcher messages.
///
/// The CLI can stay alive after its final result (for example while a background server it started is still
/// running), so the result, not the process exit, is what ends the quest. After the outcome is known the
/// process is asked to stop (`stop_soft` closes stdin), given `grace` to exit, then `stop_hard` kills the tree.
/// The returned value always carries the final exit code when the process ended.
pub fn resolve_run(rx: &Receiver<RunMsg>, grace: Duration, mut stop_soft: impl FnMut(), mut stop_hard: impl FnMut()) -> Resolved {
    let mut out = Resolved::default();
    let mut ended = false; // stdout finished or result seen
    // 1. wait for the outcome (no timeout: a quest may legitimately run for hours)
    loop {
        match rx.recv() {
            Ok(RunMsg::Result(v, d)) => {
                out.result = Some(v);
                out.denials = d;
                break;
            }
            Ok(RunMsg::StreamEnd) => {
                ended = true;
                break;
            }
            Ok(RunMsg::Exit(c)) => {
                out.exit_code = Some(c);
                // the result may still be in the pipe: give the reader a moment to deliver it
                match rx.recv_timeout(grace) {
                    Ok(RunMsg::Result(v, d)) => {
                        out.result = Some(v);
                        out.denials = d;
                    }
                    _ => {}
                }
                break;
            }
            Err(_) => break, // all watchers gone
        }
    }
    let _ = ended;
    // 2. make sure the process is gone, and learn its exit code
    if out.exit_code.is_none() {
        stop_soft();
        let deadline = Instant::now() + grace;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(RunMsg::Exit(c)) => {
                    out.exit_code = Some(c);
                    break;
                }
                Ok(RunMsg::Result(v, d)) if out.result.is_none() => {
                    out.result = Some(v);
                    out.denials = d;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        if out.exit_code.is_none() {
            out.forced = true;
            stop_hard();
            if let Ok(RunMsg::Exit(c)) = rx.recv_timeout(grace) {
                out.exit_code = Some(c);
            }
        }
    }
    out
}

struct Active {
    kind: RunKind,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    cancel: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    pending: Arc<Pending>,
    job: Arc<Option<Job>>,
    pid: u32,
    autopilot: Arc<AtomicBool>,
    ctx: Arc<RunCtx>,
}

#[derive(Default)]
pub struct Runner {
    active: Mutex<Option<Active>>,
}

struct RunCtx {
    app: AppHandle,
    db: Arc<Db>,
    kind: RunKind,
    seq: AtomicI64,
    project_dir: PathBuf,
    autopilot: Arc<AtomicBool>,
    inspected: Mutex<Vec<String>>,
    /// Guards the single terminal event of this run.
    finished: AtomicBool,
    probe_tx: Mutex<Option<Sender<ProbeResult>>>,
    services: Arc<crate::services::Registry>,
}

impl RunCtx {
    fn push(&self, kind: &str, title: &str, detail: &str) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let activity = Activity { seq, ts: crate::db::now_ms(), kind: kind.into(), title: title.into(), detail: detail.into() };
        match self.kind {
            RunKind::Quest { task_id, exec_id } => {
                self.db.add_event(exec_id, seq, kind, title, detail);
                emit(&self.app, AppEvent::RunActivity { task_id, activity });
            }
            RunKind::Research { project_id } | RunKind::Probe { project_id } => emit(&self.app, AppEvent::ResearchActivity { project_id, activity }),
        }
    }

    /// A local URL printed by a tool (for example a dev server banner) becomes an "Open in browser" action.
    fn found_url(&self, url: &str) {
        let RunKind::Quest { task_id, .. } = self.kind else { return };
        if self.db.has_url_service(task_id, url) {
            return;
        }
        let id = self.db.add_service(task_id, "url", url, Some(url), None);
        if let Some(service) = self.db.service(id) {
            emit(&self.app, AppEvent::ServiceFound { task_id, service });
        }
    }

    fn note_inspected(&self, path: &str) {
        let mut v = self.inspected.lock().unwrap_or_else(|p| p.into_inner());
        if v.len() < 400 && !v.iter().any(|p| p == path) {
            v.push(path.to_string());
        }
    }
}

pub struct StartRequest {
    pub app: AppHandle,
    pub db: Arc<Db>,
    pub exe: PathBuf,
    pub project_dir: PathBuf,
    pub kind: RunKind,
    pub prompt: String,
    pub policy: Policy,
    pub autopilot: bool,
    pub model: String,
    pub max_turns: u32,
    pub data_dir: PathBuf,
    /// Pass the official `--chrome` flag (quests only).
    pub chrome: bool,
    pub services: Arc<crate::services::Registry>,
    pub probe_tx: Option<Sender<ProbeResult>>,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

const SOFT_GRACE: Duration = Duration::from_secs(3);

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
        let run_id = match req.kind {
            RunKind::Quest { exec_id, .. } => format!("q{exec_id}"),
            RunKind::Research { project_id } => format!("r{project_id}"),
            RunKind::Probe { project_id } => format!("p{project_id}"),
        };
        let cfg_path = req.data_dir.join(format!("run-{run_id}.mcp.json"));
        let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let cfg = json!({"mcpServers": {"mushoku": {
            "command": self_exe.display().to_string(), "args": ["--mcp-approver"],
            "env": {"MUSHOKU_APPROVER_ADDR": format!("127.0.0.1:{port}"), "MUSHOKU_APPROVER_TOKEN": token}
        }}});
        std::fs::write(&cfg_path, cfg.to_string()).map_err(|e| e.to_string())?;

        let args = match req.kind {
            RunKind::Quest { .. } => build_args_chrome(req.policy, &cfg_path, &req.model, req.max_turns, req.chrome),
            RunKind::Research { .. } | RunKind::Probe { .. } => research_args(&cfg_path, &req.model, req.max_turns),
        };
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
        if let Err(e) = stdin.write_all(format!("{msg}\n").as_bytes()) {
            kill_tree(pid);
            let _ = std::fs::remove_file(&cfg_path);
            return Err(format!("could not send the prompt: {e}"));
        }
        let stdin = Arc::new(Mutex::new(Some(stdin)));
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let cancel = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let pending = Arc::new(Pending::default());
        let autopilot = Arc::new(AtomicBool::new(req.autopilot && matches!(req.kind, RunKind::Quest { .. })));
        let kill_claude = Arc::new(AtomicBool::new(false));
        let ctx = Arc::new(RunCtx {
            app: req.app.clone(),
            db: req.db.clone(),
            kind: req.kind,
            seq: AtomicI64::new(0),
            project_dir: req.project_dir.clone(),
            autopilot: autopilot.clone(),
            inspected: Mutex::new(Vec::new()),
            finished: AtomicBool::new(false),
            probe_tx: Mutex::new(req.probe_tx),
            services: req.services.clone(),
        });
        *slot = Some(Active { kind: req.kind, stdin: stdin.clone(), cancel: cancel.clone(), exited: exited.clone(), pending: pending.clone(), job: job.clone(), pid, autopilot: autopilot.clone(), ctx: ctx.clone() });
        drop(slot);

        if job.is_none() {
            ctx.push("info", "Process cleanup", "Windows job object unavailable; falling back to taskkill for cleanup.");
        }
        if let RunKind::Quest { task_id, exec_id } = req.kind {
            emit(&req.app, AppEvent::RunStarted { task_id, execution_id: exec_id, autopilot: autopilot.load(Ordering::SeqCst) });
            if req.chrome {
                ctx.push("info", "Claude in Chrome is enabled", "Claude may use your browser (official integration). Browser actions still ask for permission, and the extension keeps its own site permissions.");
            }
            if autopilot.load(Ordering::SeqCst) {
                ctx.push("info", "Auto Pilot is ON for this quest", "Routine Bash commands are approved automatically. Risky commands and everything else still ask. Cancel any time.");
            }
        }

        // approval server
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (ctx, pending, token, stop, policy) = (ctx.clone(), pending.clone(), token.clone(), stop.clone(), if matches!(req.kind, RunKind::Research { .. } | RunKind::Probe { .. }) { Policy::Research } else { req.policy });
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
        // watchers -> supervisor
        let (tx, rx) = channel::<RunMsg>();
        {
            let (ctx, stdin, tx) = (ctx.clone(), stdin.clone(), tx.clone());
            std::thread::spawn(move || read_stream(stdout, ctx, stdin, tx));
        }
        {
            let (exited, tx, kill_claude) = (exited.clone(), tx, kill_claude.clone());
            std::thread::spawn(move || {
                // Poll instead of blocking in wait(): lets the supervisor stop ONLY claude.exe (not the dev servers
                // it started, which a finished quest may leave running).
                let code = loop {
                    match child.try_wait() {
                        Ok(Some(st)) => break st.code().unwrap_or(-1),
                        Ok(None) => {
                            if kill_claude.load(Ordering::SeqCst) {
                                let _ = child.kill();
                            }
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        Err(_) => break -1,
                    }
                };
                exited.store(true, Ordering::SeqCst);
                let _ = tx.send(RunMsg::Exit(code));
            });
        }
        // supervisor: exactly one terminal outcome per run
        let me = self.clone();
        std::thread::spawn(move || {
            let (s_stdin, s_job) = (stdin.clone(), job.clone());
            let resolved = resolve_run(
                &rx,
                SOFT_GRACE,
                || *s_stdin.lock().unwrap_or_else(|p| p.into_inner()) = None, // closing stdin lets the CLI exit
                || {
                    // The CLI ignored the stdin close (a background tool keeps it alive): stop claude.exe itself.
                    kill_claude.store(true, Ordering::SeqCst);
                },
            );
            let _ = &s_job;
            // What is still running inside the quest's job now belongs to the quest's services, not to Claude.
            let was_cancelled = cancel.load(Ordering::SeqCst);
            let completed = final_status(was_cancelled, resolved.result.as_ref()).0 == "completed";
            let mut kept = false;
            if let (RunKind::Quest { task_id, .. }, Some(j)) = (ctx.kind, job.as_ref()) {
                if completed {
                    let leftovers: Vec<(u32, String)> = j
                        .pids()
                        .into_iter()
                        .filter(|p| *p != pid)
                        .filter_map(|p| crate::services::process_name(p).map(|n| (p, n)))
                        .filter(|(_, n)| !matches!(n.to_ascii_lowercase().as_str(), "conhost.exe" | "bash.exe" | "sh.exe" | "openconsole.exe"))
                        .collect();
                    if !leftovers.is_empty() {
                        for (p, n) in &leftovers {
                            let id = ctx.db.add_service(task_id, "process", &format!("{n} (pid {p})"), None, Some(*p as i64));
                            if let Some(service) = ctx.db.service(id) {
                                emit(&ctx.app, AppEvent::ServiceFound { task_id, service });
                            }
                        }
                        ctx.services.keep(task_id, job.clone());
                        kept = true;
                    }
                }
            }
            if !kept {
                if let Some(j) = job.as_ref() {
                    j.terminate(); // nothing worth keeping: sweep whatever the tool calls left behind
                } else {
                    kill_tree(pid);
                }
            }
            stop.store(true, Ordering::SeqCst);
            pending.deny_all("run ended");
            let _ = std::fs::remove_file(&cfg_path);
            let tail = err_tail.lock().unwrap_or_else(|p| p.into_inner()).trim().to_string();
            finish_run(&ctx, &resolved, was_cancelled, &tail);
            *me.active.lock().unwrap_or_else(|p| p.into_inner()) = None;
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
            while !exited.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(4) {
                std::thread::sleep(Duration::from_millis(100));
            }
            *stdin.lock().unwrap_or_else(|p| p.into_inner()) = None;
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

    /// Turns Auto Pilot on or off for the running quest. Takes effect for the next permission request.
    pub fn set_autopilot(&self, on: bool) -> bool {
        let guard = self.active.lock().unwrap_or_else(|p| p.into_inner());
        let Some(a) = guard.as_ref() else { return false };
        let RunKind::Quest { task_id, .. } = a.kind else { return false };
        a.autopilot.store(on, Ordering::SeqCst);
        a.ctx.push(
            "info",
            if on { "Auto Pilot turned ON" } else { "Auto Pilot turned OFF" },
            if on { "Routine Bash commands are approved automatically from now on." } else { "Every permission request will ask you again." },
        );
        emit(&a.ctx.app, AppEvent::RunMode { task_id, autopilot: on });
        true
    }

    pub fn active_task(&self) -> Option<i64> {
        match self.active.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|a| a.kind) {
            Some(RunKind::Quest { task_id, .. }) => Some(task_id),
            _ => None,
        }
    }

    pub fn active_research(&self) -> Option<i64> {
        match self.active.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|a| a.kind) {
            Some(RunKind::Research { project_id }) | Some(RunKind::Probe { project_id }) => Some(project_id),
            _ => None,
        }
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

/// Writes the single terminal state of a run and tells the UI. Safe against duplicates.
fn finish_run(ctx: &RunCtx, resolved: &Resolved, was_cancelled: bool, stderr_tail: &str) {
    if ctx.finished.swap(true, Ordering::SeqCst) {
        return; // a terminal event was already sent for this run
    }
    let (status, mut note) = final_status(was_cancelled, resolved.result.as_ref());
    if resolved.result.is_none() && !was_cancelled {
        let code = resolved.exit_code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
        note = Some(if stderr_tail.is_empty() { format!("Claude Code ended without producing a result{code}.") } else { format!("Claude Code ended without producing a result{code}. Its error output: {}", truncate(stderr_tail, 600)) });
    }
    let result_text = resolved.result.as_ref().and_then(|r| r["result"].as_str()).map(String::from);
    let turns = resolved.result.as_ref().and_then(|r| r["num_turns"].as_i64());
    let research_like = matches!(ctx.kind, RunKind::Research { .. } | RunKind::Probe { .. });
    let title = match (status, research_like) {
        ("completed", true) => "Research completed",
        ("completed", false) => "Execution completed",
        ("cancelled", true) => "Research cancelled",
        ("cancelled", false) => "Execution cancelled",
        (_, true) => "Research failed",
        _ => "Execution failed",
    };
    let exit = resolved.exit_code.map(|c| format!("exit code {c}")).unwrap_or_else(|| "exit code unknown".into());
    let detail = format!("{}{}", note.as_deref().or(result_text.as_deref()).map(|t| truncate(t, 1500)).unwrap_or_default(), if resolved.forced { format!("\n({exit}; the process had to be stopped after finishing)") } else { format!("\n({exit})") });
    crate::repo_cmds::kick(); // files and Git history may have changed: refresh the Repo tab
    ctx.push(if status == "completed" { "result" } else if status == "cancelled" { "cancelled" } else { "error" }, title, detail.trim());
    match ctx.kind {
        RunKind::Quest { task_id, exec_id } => {
            if status == "completed" {
                for u in crate::services::detect_urls(result_text.as_deref().unwrap_or("")) {
                    ctx.found_url(&u);
                }
            }
            ctx.db.finish_execution(exec_id, status, result_text.as_deref(), turns, resolved.denials, note.as_deref(), resolved.exit_code.map(i64::from));
            let _ = ctx.db.set_status(task_id, status);
            emit(&ctx.app, AppEvent::TaskStatus { task_id, status: status.into() });
            emit(&ctx.app, AppEvent::RunFinished { task_id, execution_id: exec_id, status: status.into(), result: result_text, note, exit_code: resolved.exit_code });
        }
        RunKind::Probe { .. } => {
            let files = ctx.inspected.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let text = crate::project_context::redact(result_text.as_deref().unwrap_or(""));
            if let Some(tx) = ctx.probe_tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = tx.send(ProbeResult { status: status.to_string(), text, files, note });
            }
        }
        RunKind::Research { project_id } => {
            let files = ctx.inspected.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let fp = crate::project_context::fingerprint(&ctx.project_dir);
            let report = (status == "completed").then(|| crate::project_context::redact(result_text.as_deref().unwrap_or("")));
            let report = report.filter(|r| !r.trim().is_empty());
            let final_state = if status == "completed" && report.is_none() { "failed" } else if status == "completed" { "ready" } else { status };
            let n = if final_state == "failed" && report.is_none() && status == "completed" { Some("Claude finished without writing a report.".to_string()) } else { note };
            ctx.db.research_finished(project_id, final_state, report.as_deref(), &files, &fp, n.as_deref());
            if let Some(r) = ctx.db.research(project_id) {
                emit(&ctx.app, AppEvent::ResearchFinished { project_id, research: r });
            }
        }
    }
}

fn read_stream(stdout: std::process::ChildStdout, ctx: Arc<RunCtx>, stdin: Arc<Mutex<Option<ChildStdin>>>, tx: Sender<RunMsg>) {
    let mut tools: HashMap<String, String> = HashMap::new();
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
                let denials = ev["permission_denials"].as_array().map(|a| a.len() as i64).unwrap_or(0);
                *stdin.lock().unwrap_or_else(|p| p.into_inner()) = None; // done: closing stdin lets the CLI exit
                let _ = tx.send(RunMsg::Result(ev, denials));
                // keep draining so the CLI never blocks on a full pipe while it shuts down
            }
            _ => {
                for n in normalize(&ev, &mut tools) {
                    if n.kind == "tool_use" && matches!(n.title.as_str(), "Read") {
                        ctx.note_inspected(&n.detail);
                    }
                    ctx.push(n.kind, &n.title, &n.detail);
                    if matches!(n.kind, "tool_result" | "assistant_text") {
                        for u in crate::services::detect_local_urls(&n.detail) {
                            ctx.found_url(&u);
                        }
                    }
                }
            }
        }
    }
    let _ = tx.send(RunMsg::StreamEnd);
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
    let exec_id = match ctx.kind {
        RunKind::Quest { exec_id, .. } => Some(exec_id),
        _ => None,
    };
    let record = |decision: &str, by: &str| {
        if let Some(e) = exec_id {
            ctx.db.add_approval(e, &tool, &summary, decision, by);
        }
    };
    if policy == Policy::Research {
        // Read-only research: Bash only for read-only git, hardened so repository config cannot run anything.
        if tool == "Bash" {
            if let Some(hardened) = crate::autopilot::harden_readonly_git(input["command"].as_str().unwrap_or("")) {
                let mut updated = input.clone();
                updated["command"] = Value::String(hardened);
                ctx.push("permission_auto", "Read-only git allowed", &summary);
                reply(&mut s, true, &updated, "");
                return;
            }
        }
        ctx.push("permission_decision", &format!("Blocked (research is read-only): {tool}"), &summary);
        reply(&mut s, false, &input, "Denied: this is a read-only research run.");
        return;
    }
    if policy == Policy::ReadOnly {
        record("deny", "policy");
        ctx.push("permission_decision", &format!("Blocked by read-only policy: {tool}"), &summary);
        reply(&mut s, false, &input, "Denied: this run is read-only.");
        return;
    }
    // "Allow edits" policy, enforced here (not by Claude's acceptEdits mode, which would also allow rm/mv silently):
    // edits of ordinary files inside the project are approved; everything else keeps asking.
    if policy == Policy::AcceptEdits && matches!(tool.as_str(), "Edit" | "Write" | "NotebookEdit") {
        let path = input["file_path"].as_str().or_else(|| input["notebook_path"].as_str()).unwrap_or("");
        let name = path.rsplit(['/', '\\']).next().unwrap_or("");
        if crate::autopilot::path_inside(&ctx.project_dir, path) && !crate::project_context::is_sensitive_name(name) {
            record("allow", "policy");
            ctx.push("permission_auto", &format!("Auto-approved edit: {tool}"), &format!("{summary}\n(policy: allow edits inside the project)"));
            reply(&mut s, true, &input, "");
            return;
        }
    }
    // Browser tools (Claude in Chrome) are never covered by shell Auto Pilot; only plainly read-only ones may be.
    let mut reason: Option<String> = None;
    if tool.starts_with("mcp__claude-in-chrome__") {
        if ctx.autopilot.load(Ordering::SeqCst) && crate::autopilot::browser_read_only(&tool, &input) {
            record("allow", "autopilot");
            ctx.push("permission_auto", &format!("Auto-approved (read-only browser): {}", crate::autopilot::browser_short(&tool)), &summary);
            reply(&mut s, true, &input, "");
            return;
        }
        reason = Some("Browser actions always ask: Auto Pilot only covers shell commands and read-only browsing.".into());
    }
    // Auto Pilot: only ordinary Bash commands, only while ON for this quest, never anything the classifier doubts.
    if ctx.autopilot.load(Ordering::SeqCst) && tool == "Bash" {
        match crate::autopilot::classify(input["command"].as_str().unwrap_or(""), &ctx.project_dir) {
            crate::autopilot::Verdict::Safe => {
                record("allow", "autopilot");
                ctx.push("permission_auto", "Auto-approved: Bash", &format!("{summary}\n(Auto Pilot)"));
                reply(&mut s, true, &input, "");
                return;
            }
            crate::autopilot::Verdict::NeedsApproval(r) => reason = Some(format!("Auto Pilot paused: this command {r}.")),
        }
    }
    let id = random_hex(8);
    let (tx, rx) = channel::<Decision>();
    pending.0.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), tx);
    let RunKind::Quest { task_id, .. } = ctx.kind else { return };
    ctx.push("permission_request", &format!("Permission needed: {tool}"), &match &reason {
        Some(r) => format!("{summary}\n{r}"),
        None => summary.clone(),
    });
    emit(&ctx.app, AppEvent::RunPermission { task_id, request_id: id.clone(), tool_name: tool.clone(), summary: summary.clone(), input: truncate(&serde_json::to_string_pretty(&input).unwrap_or_default(), 4000), reason });
    let (allow, by) = rx.recv_timeout(APPROVAL_TIMEOUT).unwrap_or_else(|_| {
        pending.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        (false, "timeout".into())
    });
    let decision = if allow { "allow" } else { "deny" };
    record(decision, &by);
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
        assert!(!ae.contains(&"--permission-mode".to_string()), "never delegate to Claude's own acceptEdits mode");
        assert!(ae.windows(2).any(|w| w == ["--model", "haiku"]));
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
    fn research_mode_is_read_only_and_blocks_secret_paths() {
        let a = research_args(Path::new("c"), "sonnet", 40);
        let tools = a.iter().position(|x| x == "--tools").map(|i| a[i + 1].clone()).unwrap();
        assert_eq!(tools, "Read,Glob,Grep,Bash", "no Edit or Write tool exists; Bash is gated by the approver to read-only git");
        assert!(!a.iter().any(|x| x.contains("dangerously") || x == "acceptEdits" || x == "--permission-mode"));
        let deny = a.iter().position(|x| x == "--disallowedTools").map(|i| a[i + 1].clone()).unwrap();
        for p in [".env", "*.pem", "id_rsa", "node_modules", ".git"] {
            assert!(deny.contains(p), "{p}");
        }
        assert!(a.contains(&"--strict-mcp-config".to_string()));
    }

    fn feed(msgs: Vec<RunMsg>) -> Receiver<RunMsg> {
        let (tx, rx) = channel();
        for m in msgs {
            tx.send(m).unwrap();
        }
        rx
    }
    const G: Duration = Duration::from_millis(60);

    #[test]
    fn result_ends_the_run_even_if_the_process_lingers_and_it_is_then_stopped() {
        // the CLI printed its result but a background server keeps it alive: soft stop first, then the exit arrives
        let (tx, rx) = channel();
        tx.send(RunMsg::Result(json!({"is_error": false, "result": "launched"}), 0)).unwrap();
        let soft = std::cell::Cell::new(0);
        let hard = std::cell::Cell::new(0);
        let tx2 = tx.clone();
        let r = resolve_run(&rx, G, || { soft.set(soft.get() + 1); tx2.send(RunMsg::Exit(0)).unwrap(); }, || hard.set(hard.get() + 1));
        assert_eq!((soft.get(), hard.get()), (1, 0));
        assert_eq!(r.exit_code, Some(0));
        assert_eq!(final_status(false, r.result.as_ref()).0, "completed");
    }

    #[test]
    fn a_process_that_ignores_stdin_close_is_force_stopped_and_still_reaches_a_terminal_state() {
        let (tx, rx) = channel();
        tx.send(RunMsg::Result(json!({"is_error": false, "result": "ok"}), 2)).unwrap();
        let tx2 = tx.clone();
        let r = resolve_run(&rx, G, || {}, || tx2.send(RunMsg::Exit(1)).unwrap());
        assert!(r.forced);
        assert_eq!((r.exit_code, r.denials), (Some(1), 2));
        assert_eq!(final_status(false, r.result.as_ref()).0, "completed", "denials and a forced stop do not turn a finished result into a failure");
    }

    #[test]
    fn process_death_without_a_result_is_a_failure_with_its_exit_code() {
        let r = resolve_run(&feed(vec![RunMsg::Exit(137), RunMsg::StreamEnd]), G, || {}, || {});
        assert_eq!(r.exit_code, Some(137));
        assert_eq!(final_status(false, r.result.as_ref()).0, "failed");
        let r = resolve_run(&feed(vec![RunMsg::StreamEnd, RunMsg::Exit(1)]), G, || {}, || {});
        assert_eq!((r.exit_code, final_status(false, None).0), (Some(1), "failed"));
    }

    #[test]
    fn a_late_result_after_exit_is_still_used_and_cancel_wins_over_failure() {
        let aborted = json!({"is_error": true, "terminal_reason": "aborted_streaming", "result": ""});
        let r = resolve_run(&feed(vec![RunMsg::Exit(1), RunMsg::Result(aborted, 0)]), G, || {}, || {});
        assert!(r.result.is_some());
        assert_eq!(final_status(true, r.result.as_ref()).0, "cancelled");
        assert_eq!(final_status(false, r.result.as_ref()).0, "failed");
    }

    #[test]
    fn version_parse() {
        assert_eq!(parse_version("2.1.319 (Claude Code)"), Some((2, 1, 319)));
        assert_eq!(parse_version("garbage"), None);
    }
}
