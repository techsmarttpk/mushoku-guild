// Context selection: what a model may see of a repository, chosen per request. Pure so the rules are testable.
// The Rust side (context.rs) assembles the text; this module only decides what the controls offer and say.

export type ContextMode = "none" | "capsule" | "relevant" | "deep";
/** quest = quest creation / prompt writing, chat = Guild Chat, uchat = Universal Chat */
export type ContextSurface = "quest" | "chat" | "uchat";

export interface ModeInfo {
  id: ContextMode;
  label: string;
  /** one short line under the selector */
  hint: string;
  /** true when choosing this mode starts Claude Code */
  invokesClaude: boolean;
}

export const MODES: Record<ContextMode, ModeInfo> = {
  none: { id: "none", label: "No Context", hint: "Only your own message is sent. Nothing about the project leaves this computer.", invokesClaude: false },
  capsule: { id: "capsule", label: "Project Capsule", hint: "A small summary built locally: stack, scripts, layout and conventions.", invokesClaude: false },
  relevant: { id: "relevant", label: "Relevant Context", hint: "The capsule plus short excerpts of the files that match your request, found by local keyword search.", invokesClaude: false },
  deep: { id: "deep", label: "Deep Research", hint: "Claude Code will be started to read the repository (read-only) and report back with file references. This takes minutes and uses your Claude usage.", invokesClaude: true },
};

/** Which modes each surface offers. Universal Chat never starts Claude Code. */
export function modesFor(surface: ContextSurface): ContextMode[] {
  return surface === "uchat" ? ["none", "capsule", "relevant"] : ["none", "capsule", "relevant", "deep"];
}

/** New users start light. Universal Chat starts with nothing shared. */
export const DEFAULT_MODE: Record<ContextSurface, ContextMode> = { quest: "capsule", chat: "capsule", uchat: "none" };

/** A stored or received value becomes a mode the surface offers; Deep Research is never restored from storage. */
export function sanitizeMode(surface: ContextSurface, v: string | null | undefined): ContextMode {
  const m = (["none", "capsule", "relevant"] as const).find((x) => x === v);
  return m && modesFor(surface).includes(m) ? m : DEFAULT_MODE[surface];
}

export interface Budgets {
  capsule: number;
  relevant: number;
}
export const DEFAULT_BUDGETS: Budgets = { capsule: 1000, relevant: 4000 };

/** Target size (tokens) of what a mode may add; null where the research workflow, not a number, bounds it. */
export function budgetFor(mode: ContextMode, b: Budgets): number | null {
  if (mode === "none") return 0;
  if (mode === "capsule") return b.capsule;
  if (mode === "relevant") return b.capsule + b.relevant;
  return null;
}

export function formatTokens(n: number): string {
  if (n <= 0) return "0 tokens";
  if (n < 1000) return `~${Math.round(n / 10) * 10 || n} tokens`;
  return `~${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tokens`;
}

/** The line shown beside the selector before sending. `tokens` is the local estimate (about 4 characters per token). */
export function sizeLabel(mode: ContextMode, tokens: number | null, busy: boolean): string {
  if (mode === "none") return "nothing from the project is sent";
  if (mode === "deep") return tokens === null || busy ? "Claude Code investigates, then the findings are sent" : `capsule ${formatTokens(tokens)} + Claude Code findings`;
  if (busy || tokens === null) return "estimating…";
  return `${formatTokens(tokens)} will be sent (estimate)`;
}

/** Shown when project text would go to a third-party model: free OpenRouter models may log prompts. */
export function thirdPartyWarning(provider: string, mode: ContextMode): string | null {
  if (provider !== "openrouter" || mode === "none") return null;
  return "This model runs on OpenRouter, a third party, and free models may keep or train on prompts. Share project text only if you are comfortable with that.";
}

/** One line for the "Context: …" chip in compact places. */
export function chip(mode: ContextMode): string {
  return `Context: ${MODES[mode].label}`;
}
