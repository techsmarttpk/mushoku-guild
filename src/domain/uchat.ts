// Universal Chat state. Deliberately separate from the repository-scoped UiState (domain/store.ts): nothing in here knows
// about projects, so switching or removing a repository cannot change a universal conversation.
import type { AppEvent, ProviderError, UConv, UMessage, UProvider, USummary } from "./types.ts";

export interface UState {
  /** provider used for the NEXT new conversation (and shown as active when no conversation is open) */
  provider: UProvider;
  /** the recruited OpenRouter model (id) for the NEXT new conversation; empty for ChatGPT and Claude */
  model: string;
  convs: USummary[];
  query: string;
  /** null = a blank draft; the conversation is created on the first message */
  current: UConv | null;
  messages: UMessage[];
  hasMore: boolean;
  streaming: boolean;
  stream: string;
  generation: number;
  error: ProviderError | null;
}

export const initialU: UState = { provider: "chatgpt", model: "", convs: [], query: "", current: null, messages: [], hasMore: false, streaming: false, stream: "", generation: 0, error: null };

export type UAction =
  | { type: "provider"; provider: UProvider; model?: string }
  | { type: "list"; convs: USummary[] }
  | { type: "query"; query: string }
  | { type: "opened"; conversation: UConv; messages: UMessage[]; hasMore: boolean }
  | { type: "draft" }
  | { type: "older"; messages: UMessage[]; hasMore: boolean }
  | { type: "sending"; conversation: UConv; message: UMessage; generation: number }
  | { type: "error"; error: ProviderError | null }
  | { type: "event"; event: AppEvent };

export function parseProvider(v: string | undefined): UProvider {
  return v === "claude" ? "claude" : "chatgpt";
}

function upsert(list: UMessage[], m: UMessage): UMessage[] {
  return list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
}

export function reduceU(s: UState, a: UAction): UState {
  switch (a.type) {
    case "provider":
      // A conversation belongs to one provider. Choosing the other provider starts a fresh draft instead of mixing histories.
      // The same holds for models: picking a different recruited model never continues another model's conversation.
      if (s.current && (s.current.provider !== a.provider || (a.provider === "openrouter" && s.current.model !== (a.model ?? "")))) {
        return { ...s, provider: a.provider, model: a.model ?? "", current: null, messages: [], hasMore: false, stream: "", streaming: false, error: null };
      }
      return { ...s, provider: a.provider, model: a.provider === "openrouter" ? (a.model ?? s.model) : "" };
    case "list":
      return { ...s, convs: a.convs };
    case "query":
      return { ...s, query: a.query };
    case "opened":
      return { ...s, provider: a.conversation.provider, model: a.conversation.provider === "openrouter" ? a.conversation.model : "", current: a.conversation, messages: a.messages, hasMore: a.hasMore, stream: "", streaming: false, error: null };
    case "draft":
      return { ...s, current: null, messages: [], hasMore: false, stream: "", streaming: false, error: null };
    case "older":
      return { ...s, messages: [...a.messages.filter((m) => !s.messages.some((x) => x.id === m.id)), ...s.messages], hasMore: a.hasMore };
    case "sending":
      return { ...s, provider: a.conversation.provider, model: a.conversation.provider === "openrouter" ? a.conversation.model : "", current: a.conversation, messages: upsert(s.messages, a.message), generation: a.generation, streaming: true, stream: "", error: null };
    case "error":
      return { ...s, error: a.error };
    case "event":
      return reduceUEvent(s, a.event);
  }
}

function reduceUEvent(s: UState, e: AppEvent): UState {
  switch (e.type) {
    case "u_chat_delta":
      if (e.conversationId !== s.current?.id || e.generation < s.generation) return s;
      return { ...s, generation: e.generation, streaming: true, stream: s.stream + e.text };
    case "u_chat_done":
      if (e.conversationId !== s.current?.id) return s;
      return { ...s, streaming: false, stream: "", messages: upsert(s.messages, e.message) };
    case "u_chat_failed":
      if (e.conversationId !== s.current?.id || e.generation < s.generation) return s;
      return { ...s, streaming: false, stream: "", error: e.kind === "cancelled" ? null : { kind: e.kind, message: e.message } };
    case "u_chat_title":
      return {
        ...s,
        convs: s.convs.map((c) => (c.id === e.conversationId ? { ...c, title: e.title } : c)),
        current: s.current?.id === e.conversationId ? { ...s.current, title: e.title } : s.current,
      };
    default:
      return s;
  }
}

export const PROVIDER_NAME: Record<UProvider, string> = { chatgpt: "ChatGPT", claude: "Claude", openrouter: "OpenRouter" };

/** What to call the speaker of a conversation: the recruited model's name when known, otherwise its id. */
export function speakerName(provider: UProvider, model: string, names: ReadonlyMap<string, string>): string {
  return provider === "openrouter" ? (names.get(model) ?? (model || "OpenRouter model")) : PROVIDER_NAME[provider];
}
