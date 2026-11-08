// Typed wrappers around the Rust commands. The frontend only ever talks to Rust through these.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppEvent,
  ChatGptStatus,
  ChatOpen,
  ResearchView,
  ClaudeInfo,
  ContextInfo,
  Draft,
  Model,
  Policy,
  ProviderError,
  Project,
  Snapshot,
  Task,
  TaskDetail,
} from "./domain/types.ts";

/** Rust-published window state: WebView2 itself does not report minimisation to the page. */
export const onWindowMinimized = (handler: (minimized: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>("window-minimized", (e) => handler(e.payload));


// ---- product commands (Rust owns all of these; each is one narrow, typed operation)

/** Tauri rejects with the serialised Rust error; normalise anything else into the same shape. */
export function toProviderError(e: unknown): ProviderError {
  if (typeof e === "object" && e !== null && "message" in e && "kind" in e) return e as ProviderError;
  return { kind: "other", message: typeof e === "string" ? e : e instanceof Error ? e.message : "Unknown error" };
}

export const onAppEvent = (handler: (e: AppEvent) => void): Promise<UnlistenFn> =>
  listen<AppEvent>("mg-event", (e) => handler(e.payload));

export const api = {
  snapshot: () => invoke<Snapshot>("snapshot"),
  settingsSet: (key: string, value: string) => invoke<void>("settings_set", { key, value }),
  projectPick: () => invoke<Project | null>("project_pick"),
  projectContext: (projectId: number, refresh: boolean) => invoke<ContextInfo>("project_context", { projectId, refresh }),
  projectSelect: (id: number) => invoke<void>("project_select", { id }),
  taskList: (projectId: number) => invoke<Task[]>("task_list", { projectId }),
  taskCreate: (projectId: number, title: string, description: string) =>
    invoke<Task>("task_create", { projectId, title, description }),
  taskGet: (id: number) => invoke<TaskDetail>("task_get", { id }),
  taskAccept: (id: number) => invoke<void>("task_accept", { id }),
  chatgptConnect: () => invoke<ChatGptStatus>("chatgpt_connect"),
  chatgptCancelConnect: () => invoke<void>("chatgpt_cancel_connect"),
  chatgptDisconnect: () => invoke<void>("chatgpt_disconnect"),
  chatgptModels: () => invoke<Model[]>("chatgpt_models"),
  reasonerGenerate: (taskId: number, note: string | null) => invoke<number>("reasoner_generate", { taskId, note }),
  reasonerCancel: () => invoke<void>("reasoner_cancel"),
  promptSave: (taskId: number, body: string) => invoke<Draft>("prompt_save", { taskId, body }),
  promptApprove: (taskId: number, draftId: number) => invoke<void>("prompt_approve", { taskId, draftId }),
  claudeDetect: () => invoke<ClaudeInfo>("claude_detect"),
  claudePickExe: () => invoke<string | null>("claude_pick_exe"),
  runStart: (taskId: number, policy: Policy, autopilot: boolean) => invoke<void>("run_start", { taskId, policy, autopilot }),
  runSetAutopilot: (on: boolean) => invoke<boolean>("run_set_autopilot", { on }),
  researchGet: (projectId: number) => invoke<ResearchView>("research_get", { projectId }),
  researchStart: (projectId: number) => invoke<ResearchView>("research_start", { projectId }),
  researchCancel: () => invoke<boolean>("research_cancel"),
  chatOpen: (projectId: number) => invoke<ChatOpen>("chat_open", { projectId }),
  chatNew: (projectId: number) => invoke<ChatOpen>("chat_new", { projectId }),
  chatSend: (conversationId: number, text: string) => invoke<number>("chat_send", { conversationId, text }),
  chatCancel: () => invoke<void>("chat_cancel"),
  runCancel: () => invoke<boolean>("run_cancel"),
  permissionDecide: (requestId: string, allow: boolean) => invoke<boolean>("permission_decide", { requestId, allow }),
};
