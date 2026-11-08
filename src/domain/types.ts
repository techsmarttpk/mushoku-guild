// Shapes returned by the Rust core (camelCase, see src-tauri/src/db.rs and events.rs).
export type TaskStatus =
  | "draft"
  | "reasoning"
  | "prompt_ready"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "accepted";

export type ErrorKind =
  | "not_connected"
  | "auth_expired"
  | "eligibility"
  | "usage_limit"
  | "network"
  | "cancelled"
  | "protocol"
  | "not_found"
  | "other";

export interface ProviderError {
  kind: ErrorKind;
  message: string;
}

export type Policy = "read_only" | "ask_each" | "accept_edits";

export interface Project {
  id: number;
  path: string;
  name: string;
  lastUsedAt: number;
  identity: string;
}

export interface Task {
  id: number;
  projectId: number;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Draft {
  id: number;
  taskId: number;
  version: number;
  body: string;
  source: "reasoner" | "user";
  model: string | null;
  approved: boolean;
  createdAt: number;
}

export interface Execution {
  id: number;
  taskId: number;
  policy: Policy;
  status: string;
  startedAt: number;
  endedAt: number | null;
  resultText: string | null;
  numTurns: number | null;
  denialCount: number;
  note: string | null;
  exitCode: number | null;
  permissionMode: "ask" | "autopilot";
  model: string;
}

export interface Activity {
  seq: number;
  ts: number;
  kind: string;
  title: string;
  detail: string;
}

export interface TaskDetail {
  task: Task;
  drafts: Draft[];
  executions: Execution[];
  events: Activity[];
}

export interface ChatGptStatus {
  connected: boolean;
  label: string | null;
}

export interface Model {
  slug: string;
  displayName: string;
}

export interface ClaudeInfo {
  path: string | null;
  version: string | null;
  signer: string | null;
  signatureValid: boolean;
  loggedIn: boolean | null;
  authMethod: string | null;
  warnings: string[];
  error: string | null;
}

export interface Snapshot {
  projects: Project[];
  settings: Record<string, string>;
  dbNote: string | null;
  chatgpt: ChatGptStatus;
  runningTask: number | null;
}

export type AppEvent =
  | { type: "chatgpt_auth"; stage: string; url: string | null }
  | { type: "reasoner_delta"; taskId: number; generation: number; text: string }
  | { type: "reasoner_done"; taskId: number; generation: number; draft: Draft }
  | { type: "reasoner_failed"; taskId: number; generation: number; kind: ErrorKind; message: string }
  | { type: "task_status"; taskId: number; status: TaskStatus }
  | { type: "run_started"; taskId: number; executionId: number; autopilot: boolean }
  | { type: "run_mode"; taskId: number; autopilot: boolean }
  | { type: "run_activity"; taskId: number; activity: Activity }
  | { type: "run_permission"; taskId: number; requestId: string; toolName: string; summary: string; input: string; reason: string | null }
  | { type: "run_permission_resolved"; requestId: string; decision: string }
  | { type: "run_finished"; taskId: number; executionId: number; status: string; result: string | null; note: string | null; exitCode: number | null }
  | { type: "chat_delta"; conversationId: number; generation: number; text: string }
  | { type: "chat_done"; conversationId: number; generation: number; message: ChatMessage }
  | { type: "chat_failed"; conversationId: number; generation: number; kind: ErrorKind; message: string }
  | { type: "chat_researching"; conversationId: number; generation: number; objective: string }
  | { type: "chat_agent_message"; conversationId: number; generation: number; message: ChatMessage }
  | { type: "chat_title"; conversationId: number; title: string }
  | { type: "service_found"; taskId: number; service: ServiceRow }
  | { type: "research_activity"; projectId: number; activity: Activity }
  | { type: "research_finished"; projectId: number; research: { projectId: number; status: string; report: string; files: string[]; researchedAt: number; note: string | null } }
  | { type: "claude_rate"; fiveHour: number | null; sevenDay: number | null; status: string | null };

export interface ContextInfo {
  status: "ready" | "stale" | "unavailable";
  text: string;
  collectedAt: number;
  sources: string[];
  truncated: boolean;
  error: string | null;
}

export type ClaudeModelChoice = "sonnet" | "opus" | "haiku" | "default";
export const MODEL_LABEL: Record<ClaudeModelChoice, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
  default: "CLI default",
};
/** Unset or unknown settings mean Sonnet (the Rust side resolves it the same way). */
export function modelChoice(setting: string | undefined): ClaudeModelChoice {
  return setting === "opus" || setting === "haiku" || setting === "default" || setting === "sonnet" ? setting : "sonnet";
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant" | "agent";
  body: string;
  createdAt: number;
  kind: "text" | "agent" | "doc";
  status: "complete" | "streaming" | "interrupted";
}

export interface Conversation {
  id: number;
  projectId: number;
  title: string;
  updatedAt: number;
}

export type ResearchStatus = "none" | "researching" | "ready" | "stale" | "failed" | "cancelled";
export interface ResearchView {
  status: ResearchStatus;
  researchedAt: number | null;
  files: string[];
  report: string;
  note: string | null;
}

export interface ChatOpen {
  conversation: Conversation;
  messages: ChatMessage[];
  research: ResearchView;
}

export interface ConvSummary {
  id: number;
  title: string;
  updatedAt: number;
  messageCount: number;
  snippet: string;
}

export interface QuestRow {
  id: number;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  model: string;
  permissionMode: string;
  summary: string;
}

export interface ServiceRow {
  id: number;
  taskId: number;
  kind: "url" | "process";
  label: string;
  url: string | null;
  pid: number | null;
  status: string;
  createdAt: number;
}
export type ServiceView = ServiceRow & { live: boolean };

export interface BrowserStatus {
  enabled: boolean;
  cliSupported: boolean;
  extensionInstalled: boolean;
  nativeHostRegistered: boolean;
  chromeRunning: boolean;
  chromePath: string | null;
  state: "disabled" | "unsupported" | "extension_missing" | "chrome_not_running" | "ready";
  message: string;
}

export type TrustState = "untrusted" | "trusted" | "reconfirm";
export interface PrefsView {
  projectId: number;
  trust: TrustState;
  policy: Policy;
  autopilot: boolean;
  trustedAt: number | null;
  identity: string;
  folderExists: boolean;
}

export interface LibraryMeta {
  path: string;
  title: string;
  size: number;
  modified: number;
}
export interface DocContent {
  path: string;
  title: string;
  modified: number;
  content: string;
  truncated: boolean;
}
