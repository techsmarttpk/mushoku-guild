//! Tauri commands: the only surface the frontend can call. Each one is a narrow, typed operation; there is
//! no generic shell, filesystem or SQL access. Rust owns orchestration, providers, processes and storage.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::chatgpt::{ChatGpt, ChatGptStatus, Model};
use crate::claude::{self, ClaudeInfo, Policy, Runner, StartRequest};
use crate::db::{Db, Draft, Project, Task, TaskDetail};
use crate::events::{emit, AppEvent, ErrorKind, ProviderError};

pub struct AppState {
    pub db: Arc<Db>,
    pub chatgpt: Arc<ChatGpt>,
    pub runner: Arc<Runner>,
    pub data_dir: PathBuf,
    generation: AtomicU64,
    gen_cancel: Mutex<Option<(i64, Arc<AtomicBool>)>>,
}

impl AppState {
    pub fn new(db: Db, data_dir: PathBuf) -> AppState {
        AppState {
            db: Arc::new(db),
            chatgpt: Arc::new(ChatGpt::default()),
            runner: Arc::new(Runner::default()),
            data_dir,
            generation: AtomicU64::new(0),
            gen_cancel: Mutex::new(None),
        }
    }
}

type R<T> = Result<T, ProviderError>;

fn e(kind: ErrorKind, m: impl Into<String>) -> ProviderError {
    ProviderError::new(kind, m)
}

const SETTING_KEYS: [&str; 6] = ["chatgpt_model", "claude_model", "claude_path", "max_turns", "policy", "current_project_id"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    projects: Vec<Project>,
    settings: HashMap<String, String>,
    db_note: Option<String>,
    chatgpt: ChatGptStatus,
    running_task: Option<i64>,
}

#[tauri::command]
pub fn snapshot(state: State<'_, AppState>) -> Snapshot {
    let settings = SETTING_KEYS.iter().filter_map(|k| state.db.setting(k).map(|v| (k.to_string(), v))).collect();
    Snapshot {
        projects: state.db.projects(),
        settings,
        db_note: state.db.recovered_note.clone(),
        chatgpt: state.chatgpt.status(),
        running_task: state.runner.active_task(),
    }
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, key: String, value: String) -> R<()> {
    if !SETTING_KEYS.contains(&key.as_str()) {
        return Err(e(ErrorKind::Other, "unknown setting"));
    }
    match key.as_str() {
        "max_turns" if value.parse::<u32>().map(|n| (1..=200).contains(&n)) != Ok(true) => return Err(e(ErrorKind::Other, "max turns must be 1-200")),
        "policy" if Policy::parse(&value).is_none() => return Err(e(ErrorKind::Other, "unknown policy")),
        "claude_model" if value.len() > 80 || value.contains(char::is_whitespace) => return Err(e(ErrorKind::Other, "invalid model name")),
        _ => {}
    }
    state.db.set_setting(&key, &value).map_err(|m| e(ErrorKind::Other, m))
}

// ---------------------------------------------------------------- projects & tasks

#[tauri::command]
pub async fn project_pick(app: AppHandle, state: State<'_, AppState>) -> R<Option<Project>> {
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Choose the project folder").blocking_pick_folder())
        .await
        .map_err(|x| e(ErrorKind::Other, x.to_string()))?;
    let Some(p) = picked else { return Ok(None) };
    let path = p.into_path().map_err(|x| e(ErrorKind::Other, x.to_string()))?;
    if !path.is_dir() {
        return Err(e(ErrorKind::NotFound, "That is not a folder."));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    let project = state.db.add_project(&path.display().to_string(), &name).map_err(|m| e(ErrorKind::Other, m))?;
    let _ = state.db.set_setting("current_project_id", &project.id.to_string());
    Ok(Some(project))
}

#[tauri::command]
pub fn project_select(state: State<'_, AppState>, id: i64) -> R<()> {
    state.db.project(id).ok_or_else(|| e(ErrorKind::NotFound, "unknown project"))?;
    state.db.touch_project(id);
    state.db.set_setting("current_project_id", &id.to_string()).map_err(|m| e(ErrorKind::Other, m))
}

#[tauri::command]
pub fn task_list(state: State<'_, AppState>, project_id: i64) -> Vec<Task> {
    state.db.tasks(project_id)
}

#[tauri::command]
pub fn task_create(state: State<'_, AppState>, project_id: i64, title: String, description: String) -> R<Task> {
    let (title, description) = (title.trim(), description.trim());
    if description.is_empty() {
        return Err(e(ErrorKind::Other, "Describe the task first."));
    }
    if description.len() > 20_000 {
        return Err(e(ErrorKind::Other, "The task description is too long (20,000 characters maximum)."));
    }
    state.db.project(project_id).ok_or_else(|| e(ErrorKind::NotFound, "unknown project"))?;
    let title = if title.is_empty() { description.chars().take(60).collect::<String>() } else { title.chars().take(120).collect() };
    state.db.create_task(project_id, &title, description).map_err(|m| e(ErrorKind::Other, m))
}

#[tauri::command]
pub fn task_get(state: State<'_, AppState>, id: i64) -> R<TaskDetail> {
    let task = state.db.task(id).ok_or_else(|| e(ErrorKind::NotFound, "unknown task"))?;
    Ok(TaskDetail { drafts: state.db.drafts(id), executions: state.db.executions(id), events: state.db.events_for_latest_execution(id), task })
}

#[tauri::command]
pub fn task_accept(app: AppHandle, state: State<'_, AppState>, id: i64) -> R<()> {
    state.db.set_status(id, "accepted").map_err(|m| e(ErrorKind::Other, m))?;
    emit(&app, AppEvent::TaskStatus { task_id: id, status: "accepted".into() });
    Ok(())
}

// ---------------------------------------------------------------- Reasoner (ChatGPT)

#[tauri::command]
pub fn chatgpt_status(state: State<'_, AppState>) -> ChatGptStatus {
    state.chatgpt.status()
}

#[tauri::command]
pub async fn chatgpt_connect(app: AppHandle, state: State<'_, AppState>) -> R<ChatGptStatus> {
    let gpt = state.chatgpt.clone();
    let a = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || gpt.connect(&|stage, url| emit(&a, AppEvent::ChatgptAuth { stage: stage.into(), url })))
        .await
        .map_err(|x| e(ErrorKind::Other, x.to_string()))?;
    emit(&app, AppEvent::ChatgptAuth { stage: if res.is_ok() { "connected" } else { "idle" }.into(), url: None });
    res
}

#[tauri::command]
pub fn chatgpt_cancel_connect(state: State<'_, AppState>) {
    state.chatgpt.cancel_connect.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn chatgpt_disconnect(state: State<'_, AppState>) {
    state.chatgpt.disconnect();
}

#[tauri::command]
pub async fn chatgpt_models(state: State<'_, AppState>) -> R<Vec<Model>> {
    let gpt = state.chatgpt.clone();
    tauri::async_runtime::spawn_blocking(move || gpt.models()).await.map_err(|x| e(ErrorKind::Other, x.to_string()))?
}

const REASONER_INSTRUCTIONS: &str = "You are the Reasoner inside Mushoku Guild, a desktop tool that hands coding work to Claude Code. \
The user describes a software task for one project. Write ONE self-contained execution prompt for Claude Code, an autonomous coding agent that \
runs inside that project's directory with file read/search/edit and shell tools while the user approves risky actions. You cannot see the \
project's files. The prompt must: state the goal and the relevant context; list concrete requirements and acceptance criteria; tell Claude to \
inspect the relevant code before changing it; keep changes minimal and inside the project directory; avoid destructive actions (deleting data, \
force-pushing, installing global software) unless the task explicitly requires them; run the project's existing tests or linters if any exist; \
and finish with a short summary of what changed, which files were touched and anything it could not verify. If the request is ambiguous, state \
your assumptions in a short 'Assumptions' section inside the prompt instead of asking questions. When the user later asks for changes, output \
the complete revised prompt, not a diff. Output only the prompt text in Markdown, with no preamble and no commentary.";

#[tauri::command]
pub fn reasoner_generate(app: AppHandle, state: State<'_, AppState>, task_id: i64, note: Option<String>) -> R<u64> {
    let task = state.db.task(task_id).ok_or_else(|| e(ErrorKind::NotFound, "unknown task"))?;
    let project = state.db.project(task.project_id).ok_or_else(|| e(ErrorKind::NotFound, "unknown project"))?;
    if !state.chatgpt.status().connected {
        return Err(e(ErrorKind::NotConnected, "Connect ChatGPT first."));
    }
    if state.runner.is_running() {
        return Err(e(ErrorKind::Other, "Wait for the running execution to finish first."));
    }
    state.db.set_status(task_id, "reasoning").map_err(|m| e(ErrorKind::Other, m))?;
    if let Some(n) = note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        state.db.add_message(task_id, "user", n);
    }
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some((_, old)) = state.gen_cancel.lock().unwrap_or_else(|p| p.into_inner()).replace((task_id, cancel.clone())) {
        old.store(true, Ordering::SeqCst);
    }
    emit(&app, AppEvent::TaskStatus { task_id, status: "reasoning".into() });

    let (db, gpt) = (state.db.clone(), state.chatgpt.clone());
    std::thread::spawn(move || {
        let instructions = format!("{REASONER_INSTRUCTIONS}\n\nProject name: {}\nProject directory: {}", project.name, project.path);
        let messages = db.messages(task_id);
        let model = match db.setting("chatgpt_model").filter(|m| !m.is_empty()) {
            Some(m) => Ok(m),
            None => gpt.models().and_then(|ms| ms.into_iter().next().map(|m| m.slug).ok_or_else(|| e(ErrorKind::Eligibility, "ChatGPT offers no models to this account."))),
        };
        let outcome = model.and_then(|m| {
            let a = app.clone();
            gpt.stream(&m, &instructions, &messages, &cancel, &mut |d| emit(&a, AppEvent::ReasonerDelta { task_id, generation, text: d.to_string() })).map(|t| (m, t))
        });
        match outcome {
            Ok((model, text)) if !text.trim().is_empty() => match db.add_draft(task_id, text.trim(), "reasoner", Some(&model)) {
                Ok(draft) => {
                    db.add_message(task_id, "assistant", text.trim());
                    let _ = db.set_status(task_id, "prompt_ready");
                    emit(&app, AppEvent::ReasonerDone { task_id, generation, draft });
                    emit(&app, AppEvent::TaskStatus { task_id, status: "prompt_ready".into() });
                }
                Err(m) => fail(&app, &db, task_id, generation, ProviderError::new(ErrorKind::Other, m)),
            },
            Ok(_) => fail(&app, &db, task_id, generation, ProviderError::new(ErrorKind::Protocol, "ChatGPT returned an empty prompt.")),
            Err(err) => fail(&app, &db, task_id, generation, err),
        }
    });
    Ok(generation)
}

fn fail(app: &AppHandle, db: &Db, task_id: i64, generation: u64, err: ProviderError) {
    let back = if db.drafts(task_id).is_empty() { "draft" } else { "prompt_ready" };
    let _ = db.set_status(task_id, back);
    emit(app, AppEvent::ReasonerFailed { task_id, generation, kind: err.kind, message: err.message });
    emit(app, AppEvent::TaskStatus { task_id, status: back.into() });
}

#[tauri::command]
pub fn reasoner_cancel(state: State<'_, AppState>) {
    if let Some((_, c)) = state.gen_cancel.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        c.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- prompt approval

#[tauri::command]
pub fn prompt_save(app: AppHandle, state: State<'_, AppState>, task_id: i64, body: String) -> R<Draft> {
    let task = state.db.task(task_id).ok_or_else(|| e(ErrorKind::NotFound, "unknown task"))?;
    if task.status != "prompt_ready" {
        return Err(e(ErrorKind::Other, "The prompt can only be edited while it awaits approval."));
    }
    let body = body.trim();
    if body.is_empty() {
        return Err(e(ErrorKind::Other, "The prompt is empty."));
    }
    if body.len() > 200_000 {
        return Err(e(ErrorKind::Other, "The prompt is too long."));
    }
    let draft = state.db.add_draft(task_id, body, "user", None).map_err(|m| e(ErrorKind::Other, m))?;
    state.db.add_message(task_id, "assistant", body);
    emit(&app, AppEvent::TaskStatus { task_id, status: "prompt_ready".into() });
    Ok(draft)
}

#[tauri::command]
pub fn prompt_approve(app: AppHandle, state: State<'_, AppState>, task_id: i64, draft_id: i64) -> R<()> {
    let draft = state.db.draft(draft_id).filter(|d| d.task_id == task_id).ok_or_else(|| e(ErrorKind::NotFound, "unknown prompt"))?;
    if draft.body.trim().is_empty() {
        return Err(e(ErrorKind::Other, "The prompt is empty."));
    }
    state.db.set_status(task_id, "approved").map_err(|m| e(ErrorKind::Other, m))?;
    state.db.approve_draft(draft_id).map_err(|m| e(ErrorKind::Other, m))?;
    emit(&app, AppEvent::TaskStatus { task_id, status: "approved".into() });
    Ok(())
}

// ---------------------------------------------------------------- Executor (Claude Code)

#[tauri::command]
pub async fn claude_detect(state: State<'_, AppState>) -> R<ClaudeInfo> {
    let path = state.db.setting("claude_path");
    tauri::async_runtime::spawn_blocking(move || claude::detect(path.as_deref())).await.map_err(|x| e(ErrorKind::Other, x.to_string()))
}

#[tauri::command]
pub async fn claude_pick_exe(app: AppHandle, state: State<'_, AppState>) -> R<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Choose claude.exe").add_filter("Claude Code", &["exe"]).blocking_pick_file())
        .await
        .map_err(|x| e(ErrorKind::Other, x.to_string()))?;
    let Some(p) = picked else { return Ok(None) };
    let path = p.into_path().map_err(|x| e(ErrorKind::Other, x.to_string()))?;
    if path.file_name().map(|n| n.to_string_lossy().to_lowercase()) != Some("claude.exe".into()) {
        return Err(e(ErrorKind::Other, "Please choose the file named claude.exe."));
    }
    let s = path.display().to_string();
    state.db.set_setting("claude_path", &s).map_err(|m| e(ErrorKind::Other, m))?;
    Ok(Some(s))
}

#[tauri::command]
pub fn run_start(app: AppHandle, state: State<'_, AppState>, task_id: i64, policy: String) -> R<()> {
    let policy = Policy::parse(&policy).ok_or_else(|| e(ErrorKind::Other, "Choose an execution policy."))?;
    let task = state.db.task(task_id).ok_or_else(|| e(ErrorKind::NotFound, "unknown task"))?;
    if task.status != "approved" {
        return Err(e(ErrorKind::Other, "Approve the prompt before starting Claude Code."));
    }
    let project = state.db.project(task.project_id).ok_or_else(|| e(ErrorKind::NotFound, "unknown project"))?;
    let draft = state.db.drafts(task_id).into_iter().rev().find(|d| d.approved).ok_or_else(|| e(ErrorKind::Other, "No approved prompt."))?;
    let exe = claude::locate(state.db.setting("claude_path").as_deref()).ok_or_else(|| e(ErrorKind::NotFound, "Claude Code (claude.exe) was not found. Open Setup and check Claude Code."))?;
    let max_turns = state.db.setting("max_turns").and_then(|v| v.parse().ok()).unwrap_or(40);
    let model = state.db.setting("claude_model").unwrap_or_default();
    let policy_name = match policy {
        Policy::ReadOnly => "read_only",
        Policy::AskEach => "ask_each",
        Policy::AcceptEdits => "accept_edits",
    };
    let exec_id = state.db.start_execution(task_id, draft.id, policy_name).map_err(|m| e(ErrorKind::Other, m))?;
    state.db.set_status(task_id, "running").map_err(|m| e(ErrorKind::Other, m))?;
    let _ = state.db.set_setting("policy", policy_name);
    emit(&app, AppEvent::TaskStatus { task_id, status: "running".into() });
    let res = state.runner.start(StartRequest {
        app: app.clone(),
        db: state.db.clone(),
        exe,
        project_dir: PathBuf::from(&project.path),
        task_id,
        exec_id,
        prompt: draft.body,
        policy,
        model,
        max_turns,
        data_dir: state.data_dir.join("runs"),
    });
    if let Err(m) = res {
        state.db.finish_execution(exec_id, "failed", None, None, 0, Some(&m));
        let _ = state.db.set_status(task_id, "failed");
        emit(&app, AppEvent::TaskStatus { task_id, status: "failed".into() });
        return Err(e(ErrorKind::Other, m));
    }
    Ok(())
}

#[tauri::command]
pub fn run_cancel(state: State<'_, AppState>) -> bool {
    state.runner.cancel()
}

#[tauri::command]
pub fn permission_decide(state: State<'_, AppState>, request_id: String, allow: bool) -> bool {
    state.runner.decide(&request_id, allow)
}

pub fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("mushoku-guild"))
}
