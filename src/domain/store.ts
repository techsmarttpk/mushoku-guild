// UI state and the pure reducer that folds Rust events into it. React only renders this state;
// everything that happens (streams, tool events, permission requests) arrives as an AppEvent.
import type {
  Activity,
  AppEvent,
  ChatGptStatus,
  ChatMessage,
  Conversation,
  ConvSummary,
  QuestRow,
  ServiceView,
  PrefsView,
  OutputLine,
  RepoState,
  ResearchView,
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
  /** why Auto Pilot did not approve it automatically */
  reason: string | null;
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
  /** Auto Pilot state of the open quest's running execution (scoped to that run only). */
  autopilot: boolean;
  conversation: Conversation | null;
  convs: ConvSummary[];
  /** ChatGPT asked Claude to investigate; the objective, while Claude works. */
  chatResearching: string | null;
  quests: QuestRow[];
  services: ServiceView[];
  prefs: PrefsView | null;
  /** The authoritative Git state, pushed by the backend (never computed in the UI). */
  repo: RepoState | null;
  output: OutputLine[];
  chatMessages: ChatMessage[];
  chatStream: string;
  chatGeneration: number;
  chatStreaming: boolean;
  chatError: ProviderError | null;
  research: ResearchView | null;
  researchActivity: Activity[];
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
  autopilot: false,
  conversation: null,
  convs: [],
  chatResearching: null,
  quests: [],
  services: [],
  prefs: null,
  repo: null,
  output: [],
  chatMessages: [],
  chatStream: "",
  chatGeneration: 0,
  chatStreaming: false,
  chatError: null,
  research: null,
  researchActivity: [],
  rate: null,
  error: null,
  finalNote: null,
};

export type Action =
  | { type: "event"; event: AppEvent }
  | { type: "patch"; patch: Partial<UiState> }
  | { type: "select_task"; detail: TaskDetail }
  | { type: "generation_started"; generation: number }
  | { type: "project_switched"; projectId: number | null }
  | { type: "chat_opened"; conversation: Conversation; messages: ChatMessage[]; research: ResearchView }
  | { type: "chat_sending"; message: ChatMessage; generation: number };

const MAX_LIVE_ACTIVITY = 800;

function withStatus(tasks: Task[], detail: TaskDetail | null, taskId: number, status: TaskStatus) {
  return {
    tasks: tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
    detail: detail && detail.task.id === taskId ? { ...detail, task: { ...detail.task, status } } : detail,
  };
}

const MAX_OUTPUT = 1500;
let outputSeq = 0;
/** Bounded output history: the newest lines win. */
export function pushOutput(list: OutputLine[], line: Omit<OutputLine, "id">): OutputLine[] {
  const next = [...list, { ...line, id: ++outputSeq }];
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
}

/** Appends a message unless its id is already there (events can repeat); replaces an optimistic local copy. */
export function addMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  if (list.some((x) => x.id === m.id)) return list.map((x) => (x.id === m.id ? m : x));
  return [...list.filter((x) => !(x.id < 0 && x.role === m.role && x.body === m.body)), m];
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
        autopilot: a.detail.task.status === "running" && a.detail.executions.at(-1)?.permissionMode === "autopilot",
        error: null,
      };
    case "generation_started":
      return { ...s, streamText: "", streaming: false, streamGeneration: a.generation, error: null };
    case "project_switched":
      // A repository is a workspace: nothing from the previous one may stay on screen.
      return {
        ...s,
        currentProjectId: a.projectId,
        selectedTaskId: null,
        detail: null,
        activity: [],
        permissions: [],
        currentTool: null,
        autopilot: false,
        tasks: [],
        quests: [],
        services: [],
        prefs: null,
        repo: null,
        output: [],
        context: null,
        conversation: null,
        convs: [],
        chatMessages: [],
        chatStream: "",
        chatStreaming: false,
        chatResearching: null,
        chatError: null,
        research: null,
        researchActivity: [],
        error: null,
        finalNote: null,
      };
    case "chat_opened":
      return { ...s, conversation: a.conversation, chatMessages: a.messages, research: a.research, chatStream: "", chatStreaming: false, chatResearching: null, chatError: null };
    case "chat_sending":
      return { ...s, chatMessages: [...s.chatMessages, a.message], chatGeneration: a.generation, chatStream: "", chatStreaming: true, chatError: null };
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
      return { ...s, activity: [], permissions: [], currentTool: null, finalNote: null, error: null, autopilot: e.autopilot };
    case "run_mode":
      return e.taskId === s.selectedTaskId ? { ...s, autopilot: e.autopilot } : s;
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
          { requestId: e.requestId, taskId: e.taskId, toolName: e.toolName, summary: e.summary, input: e.input, reason: e.reason },
        ],
      };
    case "run_permission_resolved":
      return { ...s, permissions: s.permissions.filter((p) => p.requestId !== e.requestId) };
    case "run_finished": {
      // The one terminal event of an execution: applies even when another task is open, and is idempotent.
      const status = e.status === "completed" || e.status === "cancelled" ? e.status : "failed";
      const applied = withStatus(s.tasks, s.detail, e.taskId, status);
      if (e.taskId !== s.selectedTaskId) return { ...s, tasks: applied.tasks };
      return { ...s, ...applied, permissions: [], currentTool: null, autopilot: false, finalNote: e.note ?? e.result };
    }
    case "chat_delta":
      if (e.conversationId !== s.conversation?.id || e.generation < s.chatGeneration) return s;
      return { ...s, chatGeneration: e.generation, chatStreaming: true, chatStream: s.chatStream + e.text };
    case "chat_done":
      if (e.conversationId !== s.conversation?.id) return s;
      return { ...s, chatStreaming: false, chatStream: "", chatResearching: null, chatMessages: addMessage(s.chatMessages, e.message) };
    case "chat_agent_message":
      // an intermediate contribution (ChatGPT's preface, or Claude's findings): the turn is still running
      if (e.conversationId !== s.conversation?.id) return s;
      return { ...s, chatStream: "", chatResearching: e.message.role === "agent" ? null : s.chatResearching, chatMessages: addMessage(s.chatMessages, e.message) };
    case "chat_researching":
      return e.conversationId === s.conversation?.id ? { ...s, chatResearching: e.objective, chatStream: "" } : s;
    case "chat_title":
      return { ...s, convs: s.convs.map((c) => (c.id === e.conversationId ? { ...c, title: e.title } : c)), conversation: s.conversation?.id === e.conversationId ? { ...s.conversation, title: e.title } : s.conversation };
    case "repo_state":
      return e.projectId === s.currentProjectId ? { ...s, repo: e.state } : s;
    case "git_output":
      return e.projectId === s.currentProjectId ? { ...s, output: pushOutput(s.output, { source: "git", stream: e.error ? "err" : "out", text: e.text }) } : s;
    case "cmd_output":
      return e.projectId === s.currentProjectId ? { ...s, output: pushOutput(s.output, { source: "cmd", runId: e.runId, stream: e.stream === "err" ? "err" : e.stream === "info" ? "info" : "out", text: e.text }) } : s;
    case "cmd_exit":
      return e.projectId === s.currentProjectId ? { ...s, output: pushOutput(s.output, { source: "cmd", runId: e.runId, stream: e.code === 0 ? "info" : "err", text: `[exit code ${e.code}]` }) } : s;
    case "service_found":
      return e.taskId === s.selectedTaskId && !s.services.some((x) => x.id === e.service.id) ? { ...s, services: [...s.services, { ...e.service, live: true }] } : s;
    case "chat_failed":
      if (e.conversationId !== s.conversation?.id || e.generation < s.chatGeneration) return s;
      return { ...s, chatStreaming: false, chatStream: "", chatResearching: null, chatError: e.kind === "cancelled" ? null : { kind: e.kind, message: e.message } };
    case "research_activity":
      return s.conversation && e.projectId === s.conversation.projectId ? { ...s, researchActivity: [...s.researchActivity, e.activity].slice(-MAX_LIVE_ACTIVITY) } : s;
    case "research_finished":
      return s.conversation && e.projectId === s.conversation.projectId
        ? {
            ...s,
            research: {
              status: e.research.status as ResearchView["status"],
              researchedAt: e.research.report ? e.research.researchedAt : (s.research?.researchedAt ?? null),
              files: e.research.files.length ? e.research.files : (s.research?.files ?? []),
              report: e.research.report || s.research?.report || "",
              note: e.research.note,
            },
          }
        : s;
    case "u_chat_delta":
    case "u_chat_done":
    case "u_chat_failed":
    case "u_chat_title":
      return s; // Universal Chat has its own state (domain/uchat.ts) and never touches repository state
    case "claude_rate":
      return { ...s, rate: { fiveHour: e.fiveHour, sevenDay: e.sevenDay, status: e.status } };
  }
}
