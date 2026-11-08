//! Typed events pushed from the Rust core to the UI (one ordered stream, event name `mg-event`).
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::{ChatMessage, Draft, Research, ServiceRow};

/// Error taxonomy shared by both providers.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    NotConnected,
    AuthExpired,
    Eligibility,
    UsageLimit,
    Network,
    Cancelled,
    Protocol,
    NotFound,
    Other,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        ProviderError { kind, message: message.into() }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub title: String,
    pub detail: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AppEvent {
    ChatgptAuth { stage: String, url: Option<String> },
    ReasonerDelta { task_id: i64, generation: u64, text: String },
    ReasonerDone { task_id: i64, generation: u64, draft: Draft },
    ReasonerFailed { task_id: i64, generation: u64, kind: ErrorKind, message: String },
    TaskStatus { task_id: i64, status: String },
    RunStarted { task_id: i64, execution_id: i64, autopilot: bool },
    RunMode { task_id: i64, autopilot: bool },
    RunActivity { task_id: i64, activity: Activity },
    RunPermission { task_id: i64, request_id: String, tool_name: String, summary: String, input: String, reason: Option<String> },
    RunPermissionResolved { request_id: String, decision: String },
    /// Exactly one per execution: the outcome and the final process exit code.
    RunFinished { task_id: i64, execution_id: i64, status: String, result: Option<String>, note: Option<String>, exit_code: Option<i32> },
    ChatDelta { conversation_id: i64, generation: u64, text: String },
    ChatDone { conversation_id: i64, generation: u64, message: ChatMessage },
    ChatFailed { conversation_id: i64, generation: u64, kind: ErrorKind, message: String },
    ResearchActivity { project_id: i64, activity: Activity },
    ResearchFinished { project_id: i64, research: Research },
    ServiceFound { task_id: i64, service: ServiceRow },
    ChatResearching { conversation_id: i64, generation: u64, objective: String },
    ChatAgentMessage { conversation_id: i64, generation: u64, message: ChatMessage },
    ChatTitle { conversation_id: i64, title: String },
    ClaudeRate { five_hour: Option<f64>, seven_day: Option<f64>, status: Option<String> },
}

pub fn emit(app: &AppHandle, ev: AppEvent) {
    let _ = app.emit("mg-event", ev);
}

/// `taskkill`-style helpers need to avoid flashing console windows.
pub fn hidden(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str(" …[truncated]");
    out
}
