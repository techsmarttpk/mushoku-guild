// Typed wrappers around the Rust commands. The frontend only ever talks to Rust through these.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppEvent,
  ChatGptStatus,
  BrowserStatus,
  ChatOpen,
  ConvSummary,
  DocContent,
  LibraryMeta,
  PrefsView,
  QuestRow,
  ServiceView,
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
  runStart: (taskId: number, policy: Policy, autopilot: boolean, remember: boolean) => invoke<void>("run_start", { taskId, policy, autopilot, remember }),
  questHistory: (projectId: number) => invoke<QuestRow[]>("quest_history", { projectId }),
  chatList: (projectId: number, query: string) => invoke<ConvSummary[]>("chat_list", { projectId, query }),
  chatOpenConv: (conversationId: number) => invoke<ChatOpen>("chat_open_conv", { conversationId }),
  chatRename: (conversationId: number, title: string) => invoke<void>("chat_rename", { conversationId, title }),
  chatDelete: (conversationId: number) => invoke<void>("chat_delete", { conversationId }),
  libraryList: (projectId: number) => invoke<LibraryMeta[]>("library_list", { projectId }),
  libraryRead: (projectId: number, path: string) => invoke<DocContent>("library_read", { projectId, path }),
  libraryAsk: (projectId: number, path: string, conversationId: number | null) => invoke<{ open: ChatOpen; generation: number }>("library_ask", { projectId, path, conversationId }),
  repoPrefsGet: (projectId: number) => invoke<PrefsView>("repo_prefs_get", { projectId }),
  repoPrefsSave: (projectId: number, policy: Policy, autopilot: boolean) => invoke<PrefsView>("repo_prefs_save", { projectId, policy, autopilot }),
  repoPrefsRevoke: (projectId: number) => invoke<void>("repo_prefs_revoke", { projectId }),
  projectRelink: (projectId: number) => invoke<Project | null>("project_relink", { projectId }),
  browserStatus: () => invoke<BrowserStatus>("browser_status"),
  browserInstallExtension: () => invoke<void>("browser_install_extension"),
  browserOpenChrome: () => invoke<void>("browser_open_chrome"),
  servicesGet: (taskId: number) => invoke<ServiceView[]>("services_get", { taskId }),
  serviceOpen: (serviceId: number, chrome: boolean) => invoke<void>("service_open", { serviceId, chrome }),
  serviceStop: (serviceId: number) => invoke<boolean>("service_stop", { serviceId }),
  serviceFocus: (serviceId: number) => invoke<boolean>("service_focus", { serviceId }),
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
