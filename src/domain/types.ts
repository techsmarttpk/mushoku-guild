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
  | { type: "run_started"; taskId: number; executionId: number }
  | { type: "run_activity"; taskId: number; activity: Activity }
  | { type: "run_permission"; taskId: number; requestId: string; toolName: string; summary: string; input: string }
  | { type: "run_permission_resolved"; requestId: string; decision: string }
  | { type: "run_finished"; taskId: number; status: string; result: string | null; note: string | null }
  | { type: "claude_rate"; fiveHour: number | null; sevenDay: number | null; status: string | null };
