// UI state and the pure reducer that folds Rust events into it. React only renders this state;
// everything that happens (streams, tool events, permission requests) arrives as an AppEvent.
import type {
  Activity,
  AppEvent,
  ChatGptStatus,
  ClaudeInfo,
  ContextInfo,
  Draft,
  Project,
  ProviderError,
  Task,
  TaskDetail,
  TaskStatus,
} from "./types.ts";

export interface PermissionRequest {
  requestId: string;
  taskId: number;
  toolName: string;
  summary: string;
  input: string;
}

export interface UiState {
  projects: Project[];
  currentProjectId: number | null;
  settings: Record<string, string>;
  dbNote: string | null;
  chatgpt: ChatGptStatus;
  authStage: "idle" | "waiting_browser" | "exchanging";
  authUrl: string | null;
  claude: ClaudeInfo | null;
  context: ContextInfo | null;
  contextBusy: boolean;
  tasks: Task[];
  selectedTaskId: number | null;
  detail: TaskDetail | null;
  streamText: string;
  streamGeneration: number;
  streaming: boolean;
  activity: Activity[];
  permissions: PermissionRequest[];
  currentTool: string | null;
  rate: { fiveHour: number | null; sevenDay: number | null; status: string | null } | null;
  error: ProviderError | null;
  finalNote: string | null;
}

export const initialState: UiState = {
  projects: [],
  currentProjectId: null,
  settings: {},
  dbNote: null,
  chatgpt: { connected: false, label: null },
  authStage: "idle",
  authUrl: null,
  claude: null,
  context: null,
  contextBusy: false,
  tasks: [],
  selectedTaskId: null,
  detail: null,
  streamText: "",
  streamGeneration: 0,
  streaming: false,
  activity: [],
  permissions: [],
  currentTool: null,
  rate: null,
  error: null,
  finalNote: null,
};

export type Action =
  | { type: "event"; event: AppEvent }
  | { type: "patch"; patch: Partial<UiState> }
  | { type: "select_task"; detail: TaskDetail }
  | { type: "generation_started"; generation: number };

const MAX_LIVE_ACTIVITY = 800;

function withStatus(tasks: Task[], detail: TaskDetail | null, taskId: number, status: TaskStatus) {
  return {
    tasks: tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
    detail: detail && detail.task.id === taskId ? { ...detail, task: { ...detail.task, status } } : detail,
  };
}

function addDraft(detail: TaskDetail | null, draft: Draft): TaskDetail | null {
  if (!detail || detail.task.id !== draft.taskId) return detail;
  return { ...detail, drafts: [...detail.drafts.filter((d) => d.id !== draft.id), draft] };
}

export function reduce(s: UiState, a: Action): UiState {
  switch (a.type) {
    case "patch":
      return { ...s, ...a.patch };
    case "select_task":
      return {
        ...s,
        selectedTaskId: a.detail.task.id,
        detail: a.detail,
        activity: a.detail.events,
        streamText: "",
        streaming: false,
        permissions: [],
        currentTool: null,
        finalNote: a.detail.executions.at(-1)?.note ?? null,
        error: null,
      };
    case "generation_started":
      return { ...s, streamText: "", streaming: false, streamGeneration: a.generation, error: null };
    case "event":
      return reduceEvent(s, a.event);
  }
}

function reduceEvent(s: UiState, e: AppEvent): UiState {
  switch (e.type) {
    case "chatgpt_auth":
      return {
        ...s,
        authStage: e.stage === "waiting_browser" || e.stage === "exchanging" ? e.stage : "idle",
        authUrl: e.stage === "waiting_browser" ? e.url : null,
      };
    case "task_status":
      return { ...s, ...withStatus(s.tasks, s.detail, e.taskId, e.status) };
    case "reasoner_delta":
      if (e.taskId !== s.selectedTaskId || e.generation < s.streamGeneration) return s;
      return { ...s, streamGeneration: e.generation, streaming: true, streamText: s.streamText + e.text };
    case "reasoner_done":
      if (e.taskId !== s.selectedTaskId) return s;
      return { ...s, streaming: false, streamText: "", detail: addDraft(s.detail, e.draft) };
    case "reasoner_failed":
      if (e.taskId !== s.selectedTaskId || e.generation < s.streamGeneration) return s;
      return {
        ...s,
        streaming: false,
        streamText: "",
        error: e.kind === "cancelled" ? null : { kind: e.kind, message: e.message },
      };
    case "run_started":
      if (e.taskId !== s.selectedTaskId) return s;
      return { ...s, activity: [], permissions: [], currentTool: null, finalNote: null, error: null };
    case "run_activity": {
      if (e.taskId !== s.selectedTaskId) return s;
      const activity = [...s.activity, e.activity].slice(-MAX_LIVE_ACTIVITY);
      const k = e.activity.kind;
      const currentTool = k === "tool_use" ? e.activity.title : k === "tool_result" || k === "tool_error" ? null : s.currentTool;
      return { ...s, activity, currentTool };
    }
    case "run_permission":
      if (e.taskId !== s.selectedTaskId) return s;
      return {
        ...s,
        permissions: [
          ...s.permissions,
          { requestId: e.requestId, taskId: e.taskId, toolName: e.toolName, summary: e.summary, input: e.input },
        ],
      };
    case "run_permission_resolved":
      return { ...s, permissions: s.permissions.filter((p) => p.requestId !== e.requestId) };
    case "run_finished":
      if (e.taskId !== s.selectedTaskId) return s;
      return { ...s, permissions: [], currentTool: null, finalNote: e.note ?? e.result };
    case "claude_rate":
      return { ...s, rate: { fiveHour: e.fiveHour, sevenDay: e.sevenDay, status: e.status } };
  }
}
