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
  | { type: "reasoner_note"; taskId: number; generation: number; text: string }
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
  | { type: "repo_state"; projectId: number; state: RepoState }
  | { type: "git_output"; projectId: number; text: string; error: boolean }
  | { type: "cmd_output"; projectId: number; runId: number; stream: string; text: string }
  | { type: "cmd_exit"; projectId: number; runId: number; code: number }
  | { type: "chat_researching"; conversationId: number; generation: number; objective: string }
  | { type: "chat_agent_message"; conversationId: number; generation: number; message: ChatMessage }
  | { type: "chat_title"; conversationId: number; title: string }
  | { type: "service_found"; taskId: number; service: ServiceRow }
  | { type: "research_activity"; projectId: number; activity: Activity }
  | { type: "research_finished"; projectId: number; research: { projectId: number; status: string; report: string; files: string[]; researchedAt: number; note: string | null } }
  | { type: "u_chat_delta"; conversationId: number; generation: number; text: string }
  | { type: "u_chat_done"; conversationId: number; generation: number; message: UMessage }
  | { type: "u_chat_failed"; conversationId: number; generation: number; kind: ErrorKind; message: string }
  | { type: "u_chat_title"; conversationId: number; title: string }
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

// ---------------------------------------------------------------- Repo tab (files and Git)
export interface FsEntry {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  hidden: boolean;
  ignored: boolean;
  link: boolean;
}
export interface FileData {
  rel: string;
  content: string;
  mtime: number;
  size: number;
  large: boolean;
  crlf: boolean;
}
export interface WriteResult {
  saved: boolean;
  mtime: number;
  conflict: boolean;
}
export interface FileEntry {
  path: string;
  orig: string | null;
  index: string;
  worktree: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "conflicted" | "untracked" | string;
}
export interface BranchState {
  head: string;
  oid: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}
export interface RepoState {
  isRepo: boolean;
  root: string;
  branch: BranchState;
  entries: FileEntry[];
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  clean: boolean;
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  lastFetchMs: number | null;
  historyToken: string;
  error: string | null;
}
export interface BranchInfo {
  name: string;
  isRemote: boolean;
  current: boolean;
  oid: string;
  upstream: string | null;
  track: string;
  subject: string;
}
export interface LaneRef {
  lane: number;
  color: number;
}
export interface RefLabel {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
  current: boolean;
}
export interface GraphRow {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  time: number;
  subject: string;
  refs: RefLabel[];
  lane: number;
  color: number;
  through: LaneRef[];
  incoming: LaneRef[];
  outgoing: LaneRef[];
  isMerge: boolean;
  isHead: boolean;
}
export interface Graph {
  rows: GraphRow[];
  maxLanes: number;
  truncated: boolean;
}
export interface ChangedFile {
  status: string;
  path: string;
  orig: string | null;
}
export interface CommitDetail {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  body: string;
  refs: RefLabel[];
  files: ChangedFile[];
}
export interface Remote {
  name: string;
  fetch: string;
  push: string;
}
export interface TagInfo {
  name: string;
  oid: string;
  subject: string;
  time: number;
  annotated: boolean;
}
export interface StashInfo {
  index: number;
  name: string;
  subject: string;
  time: number;
}
export interface ConflictView {
  path: string;
  ours: string;
  theirs: string;
  base: string;
}
export interface PushPreview {
  remote: string;
  branch: string;
  upstream: string | null;
  commits: string[];
  remotes: string[];
  detached: boolean;
}
export interface OpResult {
  ok: boolean;
  label: string;
  summary: string;
  output: string;
  conflicts: boolean;
}
export type DiffSpec = { kind: "unstaged"; path: string } | { kind: "staged"; path: string } | { kind: "commit"; hash: string; path: string | null };
export type GitOp = { op: string } & Record<string, unknown>;
export interface OutputLine {
  id: number;
  source: "git" | "cmd" | "info";
  runId?: number;
  stream: "out" | "err" | "info";
  text: string;
}

// ---- quest attachments
export interface AttachmentView {
  id: number;
  name: string;
  kind: "image" | "text" | "pdf";
  mime: string;
  size: number;
}

// ---- Universal Chat (global conversations, ChatGPT or Claude; never tied to a repository)
export type UProvider = "chatgpt" | "claude" | "openrouter";
export interface UConv {
  id: number;
  title: string;
  provider: UProvider;
  model: string;
  createdAt: number;
  updatedAt: number;
}
export interface UMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  body: string;
  status: "complete" | "streaming" | "interrupted";
  createdAt: number;
}
export interface USummary {
  id: number;
  title: string;
  provider: UProvider;
  model: string;
  updatedAt: number;
  messageCount: number;
  snippet: string;
}
export interface UOpen {
  conversation: UConv;
  messages: UMessage[];
  hasMore: boolean;
}
export interface USent {
  conversation: UConv;
  message: UMessage;
  generation: number;
}
