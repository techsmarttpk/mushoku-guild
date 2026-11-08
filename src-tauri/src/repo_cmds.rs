//! Tauri commands of the Repo tab: file explorer, editor files, Git workbench, command output panel.
//! Git is the single source of truth: `Hub` re-reads it (on events and every few seconds while the Repo tab is
//! open) and pushes the full `RepoState` to the UI, so the branch shown is always the checked-out one, whoever
//! changed it (the user, a button, or a Claude quest).
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::claude::Job;
use crate::commands::AppState;
use crate::events::{emit, hidden, AppEvent, ErrorKind, ProviderError};
use crate::fsops::{self, FsError, Root};
use crate::git::{self, GitOp, LineSink, OpResult};
use crate::project_context::redact;

type R<T> = Result<T, ProviderError>;

fn err(kind: ErrorKind, m: impl Into<String>) -> ProviderError {
    ProviderError::new(kind, m)
}
fn fs_err(e: FsError) -> ProviderError {
    ProviderError::new(if e == FsError::NotFound { ErrorKind::NotFound } else { ErrorKind::Other }, e.to_string())
}
fn join_err(e: tauri::Error) -> ProviderError {
    err(ErrorKind::Other, e.to_string())
}

// ---------------------------------------------------------------- state hub

static KICK: AtomicBool = AtomicBool::new(false);
/// Ask the hub to re-read Git now (after a save, a Git operation, or a finished quest).
pub fn kick() {
    KICK.store(true, Ordering::SeqCst);
}

#[derive(Default)]
pub struct Hub {
    watched: Mutex<Option<(i64, PathBuf)>>,
    last: Mutex<String>,
    git_busy: AtomicBool,
    git_cancel: AtomicBool,
}

pub fn start_hub(app: AppHandle, hub: Arc<Hub>) {
    std::thread::spawn(move || {
        let mut last_poll = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let kicked = KICK.swap(false, Ordering::SeqCst);
            if !kicked && last_poll.elapsed() < Duration::from_secs(3) {
                continue;
            }
            last_poll = Instant::now();
            let watched = hub.watched.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let Some((project_id, path)) = watched else { continue };
            let st = git::state(&path);
            let ser = serde_json::to_string(&st).unwrap_or_default();
            let mut last = hub.last.lock().unwrap_or_else(|p| p.into_inner());
            if *last != ser {
                *last = ser;
                drop(last);
                emit(&app, AppEvent::RepoState { project_id, state: Box::new(st) });
            }
        }
    });
}

fn project_dir(state: &AppState, project_id: i64) -> R<PathBuf> {
    let p = state.db.project(project_id).ok_or_else(|| err(ErrorKind::NotFound, "unknown repository"))?;
    let d = PathBuf::from(&p.path);
    if d.is_dir() { Ok(d) } else { Err(err(ErrorKind::NotFound, "The repository folder was not found. Reconnect it in the Guild tab.")) }
}

#[tauri::command]
pub fn git_watch(state: State<'_, AppState>, project_id: Option<i64>) -> R<()> {
    let target = match project_id {
        Some(id) => Some((id, project_dir(&state, id)?)),
        None => None,
    };
    *state.hub.watched.lock().unwrap_or_else(|p| p.into_inner()) = target;
    state.hub.last.lock().unwrap_or_else(|p| p.into_inner()).clear();
    kick();
    Ok(())
}

#[tauri::command]
pub async fn git_state(state: State<'_, AppState>, project_id: i64) -> R<git::RepoState> {
    let dir = project_dir(&state, project_id)?;
    tauri::async_runtime::spawn_blocking(move || git::state(&dir)).await.map_err(join_err)
}

macro_rules! blocking {
    ($state:expr, $pid:expr, |$dir:ident| $body:expr) => {{
        let $dir = project_dir(&$state, $pid)?;
        tauri::async_runtime::spawn_blocking(move || $body).await.map_err(join_err)?.map_err(|m: String| err(ErrorKind::Other, m))
    }};
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>, project_id: i64) -> R<Vec<git::BranchInfo>> {
    blocking!(state, project_id, |d| git::branches(&d))
}
#[tauri::command]
pub async fn git_graph(state: State<'_, AppState>, project_id: i64, limit: usize) -> R<git::Graph> {
    blocking!(state, project_id, |d| git::graph(&d, limit))
}
#[tauri::command]
pub async fn git_commit_detail(state: State<'_, AppState>, project_id: i64, hash: String) -> R<git::CommitDetail> {
    blocking!(state, project_id, |d| git::commit_detail(&d, &hash))
}
#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, project_id: i64, spec: git::DiffSpec) -> R<String> {
    blocking!(state, project_id, |d| git::diff(&d, &spec))
}
#[tauri::command]
pub async fn git_remotes(state: State<'_, AppState>, project_id: i64) -> R<Vec<git::Remote>> {
    blocking!(state, project_id, |d| git::remotes(&d))
}
#[tauri::command]
pub async fn git_tags(state: State<'_, AppState>, project_id: i64) -> R<Vec<git::TagInfo>> {
    blocking!(state, project_id, |d| git::tags(&d))
}
#[tauri::command]
pub async fn git_stashes(state: State<'_, AppState>, project_id: i64) -> R<Vec<git::StashInfo>> {
    blocking!(state, project_id, |d| git::stashes(&d))
}
#[tauri::command]
pub async fn git_conflict(state: State<'_, AppState>, project_id: i64, path: String) -> R<git::ConflictView> {
    blocking!(state, project_id, |d| git::conflict(&d, &path))
}
#[tauri::command]
pub async fn git_push_preview(state: State<'_, AppState>, project_id: i64) -> R<git::PushPreview> {
    blocking!(state, project_id, |d| git::push_preview(&d))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    sentence: String,
}

#[tauri::command]
pub async fn git_sync_sentence(state: State<'_, AppState>, project_id: i64) -> R<SyncInfo> {
    let dir = project_dir(&state, project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let st = git::state(&dir);
        SyncInfo { sentence: git::sync_sentence(&st.branch, st.last_fetch_ms) }
    })
    .await
    .map_err(join_err)
}

/// Runs one Git operation. Output streams to the Output panel as it happens; the final state follows from the hub.
#[tauri::command]
pub async fn git_op(app: AppHandle, state: State<'_, AppState>, project_id: i64, op: GitOp, confirmed: bool) -> R<OpResult> {
    let dir = project_dir(&state, project_id)?;
    let destructive = matches!(&op, GitOp::Discard { .. } | GitOp::DeleteBranch { force: true, .. } | GitOp::DeleteRemoteBranch { .. } | GitOp::TagDelete { .. } | GitOp::StashDrop { .. } | GitOp::RemoteRemove { .. })
        || matches!(&op, GitOp::Push { force_with_lease: true, .. });
    if destructive && !confirmed {
        return Err(err(ErrorKind::Other, "This operation needs your explicit confirmation."));
    }
    if state.hub.git_busy.swap(true, Ordering::SeqCst) {
        return Err(err(ErrorKind::Other, "Another Git operation is still running. Wait for it or cancel it."));
    }
    state.hub.git_cancel.store(false, Ordering::SeqCst);
    let hub = state.hub.clone();
    let a = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<OpResult, String> {
        let dirty = !git::state(&dir).clean;
        let plan = git::plan(&op, dirty)?;
        emit(&a, AppEvent::GitOutput { project_id, text: format!("— {} —", plan.label), error: false });
        let a2 = a.clone();
        let sink: LineSink = Arc::new(move |l: &str| emit(&a2, AppEvent::GitOutput { project_id, text: l.to_string(), error: false }));
        let r = git::execute(&dir, &plan, sink, &hub.git_cancel);
        emit(&a, AppEvent::GitOutput { project_id, text: r.summary.clone(), error: !r.ok });
        Ok(r)
    })
    .await;
    state.hub.git_busy.store(false, Ordering::SeqCst);
    kick();
    res.map_err(join_err)?.map_err(|m| err(ErrorKind::Other, m))
}

#[tauri::command]
pub fn git_cancel(state: State<'_, AppState>) {
    state.hub.git_cancel.store(true, Ordering::SeqCst);
}

// ---------------------------------------------------------------- file explorer and editor files

fn root_of(state: &AppState, project_id: i64) -> R<Root> {
    Root::open(&project_dir(state, project_id)?).map_err(fs_err)
}

fn check_ignore(root: &std::path::Path, names: &[String]) -> Vec<String> {
    if names.is_empty() {
        return vec![];
    }
    match git::run(root, &["check-ignore", "-z", "--stdin"], Some(&names.join("\0")), Duration::from_secs(10), None, None) {
        Ok(o) if o.code == 0 => o.stdout.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect(),
        _ => vec![],
    }
}

#[tauri::command]
pub async fn fs_list(state: State<'_, AppState>, project_id: i64, rel: String, show_hidden: bool, show_ignored: bool) -> R<Vec<fsops::Entry>> {
    let root = root_of(&state, project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let base = root.path().to_path_buf();
        fsops::list_dir(&root, &rel, show_hidden, &|names| check_ignore(&base, names), show_ignored)
    })
    .await
    .map_err(join_err)?
    .map_err(fs_err)
}

#[tauri::command]
pub async fn fs_read(state: State<'_, AppState>, project_id: i64, rel: String) -> R<fsops::FileData> {
    let root = root_of(&state, project_id)?;
    tauri::async_runtime::spawn_blocking(move || fsops::read_file(&root, &rel)).await.map_err(join_err)?.map_err(fs_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub saved: bool,
    pub mtime: i64,
    /// the file changed on disk since the editor loaded it; nothing was written
    pub conflict: bool,
}

#[tauri::command]
pub async fn fs_write(state: State<'_, AppState>, project_id: i64, rel: String, content: String, crlf: bool, expected_mtime: Option<i64>, force: bool) -> R<WriteResult> {
    let root = root_of(&state, project_id)?;
    let r = tauri::async_runtime::spawn_blocking(move || fsops::write_file(&root, &rel, &content, crlf, expected_mtime, force)).await.map_err(join_err)?;
    match r {
        Ok(m) => {
            kick();
            Ok(WriteResult { saved: true, mtime: m, conflict: false })
        }
        Err(FsError::Conflict { current_mtime }) => Ok(WriteResult { saved: false, mtime: current_mtime, conflict: true }),
        Err(e) => Err(fs_err(e)),
    }
}

#[tauri::command]
pub async fn fs_create(state: State<'_, AppState>, project_id: i64, rel: String, is_dir: bool) -> R<()> {
    let root = root_of(&state, project_id)?;
    let r = tauri::async_runtime::spawn_blocking(move || fsops::create(&root, &rel, is_dir)).await.map_err(join_err)?.map_err(fs_err);
    kick();
    r
}

#[tauri::command]
pub async fn fs_rename(state: State<'_, AppState>, project_id: i64, from: String, to: String) -> R<()> {
    let root = root_of(&state, project_id)?;
    let r = tauri::async_runtime::spawn_blocking(move || fsops::rename(&root, &from, &to)).await.map_err(join_err)?.map_err(fs_err);
    kick();
    r
}

#[tauri::command]
pub async fn fs_delete(state: State<'_, AppState>, project_id: i64, rel: String, confirm_important: bool) -> R<()> {
    let root = root_of(&state, project_id)?;
    let r = tauri::async_runtime::spawn_blocking(move || fsops::delete(&root, &rel, confirm_important)).await.map_err(join_err)?.map_err(fs_err);
    kick();
    r
}

#[tauri::command]
pub async fn fs_stat(state: State<'_, AppState>, project_id: i64, rels: Vec<String>) -> R<Vec<fsops::Stat>> {
    let root = root_of(&state, project_id)?;
    tauri::async_runtime::spawn_blocking(move || fsops::stat_many(&root, &rels)).await.map_err(join_err)
}

/// Open editor tabs per repository (paths only, never contents) so the workspace can be restored.
#[tauri::command]
pub fn workspace_get(state: State<'_, AppState>, project_id: i64) -> Option<String> {
    state.db.setting(&format!("workspace:{project_id}"))
}

#[tauri::command]
pub fn workspace_save(state: State<'_, AppState>, project_id: i64, json: String) -> R<()> {
    if json.len() > 20_000 {
        return Err(err(ErrorKind::Other, "workspace too large"));
    }
    state.db.set_setting(&format!("workspace:{project_id}"), &json).map_err(|m| err(ErrorKind::Other, m))
}

// ---------------------------------------------------------------- command output panel (not a terminal)

#[derive(Default)]
pub struct CmdRegistry {
    running: Mutex<HashMap<u64, Arc<Option<Job>>>>,
    next: AtomicU64,
}

impl CmdRegistry {
    pub fn stop_all(&self) {
        for (_, j) in self.running.lock().unwrap_or_else(|p| p.into_inner()).drain() {
            if let Some(j) = j.as_ref() {
                j.terminate();
            }
        }
    }
}

/// Runs one command line in the repository folder and streams its output. Output only: there is no stdin, no
/// interactive session and no terminal emulation. It needs a trusted repository, and every process it starts
/// belongs to a Job Object, so cancelling (or quitting) stops the whole tree.
#[tauri::command]
pub fn cmd_run(app: AppHandle, state: State<'_, AppState>, project_id: i64, command: String) -> R<u64> {
    use std::os::windows::process::CommandExt;
    let dir = project_dir(&state, project_id)?;
    let project = state.db.project(project_id).ok_or_else(|| err(ErrorKind::NotFound, "unknown repository"))?;
    if crate::repo::prefs_view(&state.db, &project).trust != crate::repo::TrustState::Trusted {
        return Err(err(ErrorKind::Other, "Trust this repository first (Permissions in the Guild tab) to run commands in it."));
    }
    let command = command.trim().to_string();
    if command.is_empty() || command.len() > 2000 || command.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err(err(ErrorKind::Other, "Enter a single command line."));
    }
    if state.cmds.running.lock().unwrap_or_else(|p| p.into_inner()).len() >= 3 {
        return Err(err(ErrorKind::Other, "Three commands are already running. Stop one first."));
    }
    let mut cmd = Command::new("cmd");
    cmd.args(["/D", "/S", "/C"]).raw_arg(format!("\"{command}\"")).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, _) in std::env::vars() {
        let u = k.to_ascii_uppercase();
        if u == "ANTHROPIC_API_KEY" || u == "ANTHROPIC_AUTH_TOKEN" {
            cmd.env_remove(k);
        }
    }
    hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| err(ErrorKind::Other, format!("could not start the command: {e}")))?;
    let job = Job::new();
    let ok = job.as_ref().map(|j| {
        use std::os::windows::io::AsRawHandle;
        j.assign(child.as_raw_handle())
    });
    let job = Arc::new(job.filter(|_| ok == Some(true)));
    let run_id = state.cmds.next.fetch_add(1, Ordering::SeqCst) + 1;
    state.cmds.running.lock().unwrap_or_else(|p| p.into_inner()).insert(run_id, job.clone());
    emit(&app, AppEvent::CmdOutput { project_id, run_id, stream: "info".into(), text: format!("> {}", redact(&command)) });
    let readers: Vec<_> = [(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "out"), (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "err")]
        .into_iter()
        .filter_map(|(r, kind)| r.map(|r| (r, kind)))
        .map(|(r, kind)| {
            let a = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(r).lines().map_while(Result::ok) {
                    emit(&a, AppEvent::CmdOutput { project_id, run_id, stream: kind.into(), text: redact(&line) });
                }
            })
        })
        .collect();
    let (a, cmds) = (app.clone(), state.cmds.clone());
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        for h in readers {
            let _ = h.join();
        }
        if let Some(j) = cmds.running.lock().unwrap_or_else(|p| p.into_inner()).remove(&run_id) {
            if let Some(j) = j.as_ref() {
                j.terminate();
            }
        }
        emit(&a, AppEvent::CmdExit { project_id, run_id, code });
        kick();
    });
    Ok(run_id)
}

#[tauri::command]
pub fn cmd_cancel(state: State<'_, AppState>, run_id: u64) -> bool {
    match state.cmds.running.lock().unwrap_or_else(|p| p.into_inner()).get(&run_id) {
        Some(j) => {
            if let Some(j) = j.as_ref() {
                j.terminate();
            }
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_quest_or_a_save_asks_the_hub_to_refresh_immediately() {
        KICK.store(false, Ordering::SeqCst);
        kick();
        assert!(KICK.swap(false, Ordering::SeqCst), "kick() requests an immediate re-read of the Git state");
    }

    #[test]
    fn ignored_names_come_from_gitignore_and_non_repositories_report_none() {
        let d = std::env::temp_dir().join(format!("mg-ign-{}", std::process::id()));
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        std::fs::write(d.join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        std::fs::write(d.join("a.log"), "x").unwrap();
        std::fs::write(d.join("a.txt"), "x").unwrap();
        assert!(check_ignore(&d, &["a.txt".into(), "a.log".into(), "node_modules".into()]).is_empty(), "outside a repository nothing is ignored");
        git::run(&d, &["init", "-q"], None, Duration::from_secs(20), None, None).unwrap();
        let ig = check_ignore(&d, &["a.txt".into(), "a.log".into(), "node_modules".into()]);
        assert_eq!(ig.len(), 2);
        assert!(ig.contains(&"a.log".to_string()) && ig.contains(&"node_modules".to_string()) && !ig.contains(&"a.txt".to_string()));
        std::fs::remove_dir_all(d).ok();
    }
}
