// Pure logic of the Repo tab: editor tab bookkeeping, external-change detection, file decorations, language and
// icon choice, and graph drawing geometry. Kept free of React and CodeMirror so it can be tested directly.
import type { FileEntry, GraphRow, RepoState } from "./types.ts";

// ---------------------------------------------------------------- editor tabs

export interface EditorTab {
  rel: string;
  /** modification time of the file when it was last loaded or saved here */
  mtime: number;
  dirty: boolean;
  crlf: boolean;
  /** none | changed (modified on disk since load) | deleted */
  external: "none" | "changed" | "deleted";
}

export const fileName = (rel: string): string => rel.split("/").pop() ?? rel;

export function openTab(tabs: EditorTab[], t: { rel: string; mtime: number; crlf: boolean }): EditorTab[] {
  return tabs.some((x) => x.rel === t.rel) ? tabs : [...tabs, { rel: t.rel, mtime: t.mtime, crlf: t.crlf, dirty: false, external: "none" }];
}

export const closeTab = (tabs: EditorTab[], rel: string): EditorTab[] => tabs.filter((t) => t.rel !== rel);
export const dirtyTabs = (tabs: EditorTab[]): EditorTab[] => tabs.filter((t) => t.dirty);

export function setDirty(tabs: EditorTab[], rel: string, dirty: boolean): EditorTab[] {
  return tabs.map((t) => (t.rel === rel && t.dirty !== dirty ? { ...t, dirty } : t));
}

export function markSaved(tabs: EditorTab[], rel: string, mtime: number): EditorTab[] {
  return tabs.map((t) => (t.rel === rel ? { ...t, mtime, dirty: false, external: "none" } : t));
}

export function markReloaded(tabs: EditorTab[], rel: string, mtime: number): EditorTab[] {
  return markSaved(tabs, rel, mtime);
}

export interface StatInfo {
  rel: string;
  mtime: number;
  exists: boolean;
}

/**
 * Compares open tabs with the files on disk. Clean tabs whose file changed are returned in `reload` (safe to
 * refresh silently). Dirty tabs are NEVER touched: they get an `external` flag so the user decides.
 */
export function applyStats(tabs: EditorTab[], stats: StatInfo[]): { tabs: EditorTab[]; reload: string[] } {
  const reload: string[] = [];
  const next = tabs.map((t) => {
    const s = stats.find((x) => x.rel === t.rel);
    if (!s) return t;
    if (!s.exists) return t.external === "deleted" ? t : { ...t, external: "deleted" as const };
    if (s.mtime === t.mtime) return t.external === "changed" && !t.dirty ? { ...t, external: "none" as const } : t;
    if (!t.dirty) {
      reload.push(t.rel);
      return t;
    }
    return t.external === "changed" ? t : { ...t, external: "changed" as const };
  });
  return { tabs: next, reload };
}

/** Tab to activate after closing `rel`. */
export function nextActive(tabs: EditorTab[], closed: string, active: string | null): string | null {
  if (active !== closed) return active;
  const i = tabs.findIndex((t) => t.rel === closed);
  const rest = tabs.filter((t) => t.rel !== closed);
  return rest[Math.min(Math.max(i - 1, 0), rest.length - 1)]?.rel ?? null;
}

// ---------------------------------------------------------------- languages and icons

const LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", java: "java", kt: "kotlin", kts: "kotlin", rs: "rust", html: "html", htm: "html", css: "css", scss: "css", json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", md: "markdown", markdown: "markdown", sql: "sql", sh: "shell", bash: "shell", zsh: "shell", ps1: "shell", bat: "shell", cmd: "shell",
  xml: "html", svg: "html", vue: "html", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", go: "go", rb: "ruby", php: "php", lock: "text", txt: "text", gitignore: "text", env: "text",
};
const NAME_LANG: Record<string, string> = { dockerfile: "shell", makefile: "shell", ".gitignore": "text", ".gitattributes": "text" };

export function languageFor(path: string): string {
  const name = fileName(path).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  const ext = name.includes(".") ? name.split(".").pop() ?? "" : "";
  return LANG[ext] ?? "text";
}

export const LANGUAGE_LABEL: Record<string, string> = { typescript: "TypeScript", tsx: "TSX", javascript: "JavaScript", jsx: "JSX", python: "Python", java: "Java", kotlin: "Kotlin", rust: "Rust", html: "HTML", css: "CSS", json: "JSON", yaml: "YAML", toml: "TOML", markdown: "Markdown", sql: "SQL", shell: "Shell", c: "C", cpp: "C++", csharp: "C#", go: "Go", ruby: "Ruby", php: "PHP", text: "Plain text" };

const ICONS: Record<string, string> = { typescript: "🟦", tsx: "⚛", javascript: "🟨", jsx: "⚛", python: "🐍", java: "☕", kotlin: "🟣", rust: "🦀", html: "🌐", css: "🎨", json: "📦", yaml: "⚙", toml: "⚙", markdown: "📝", sql: "🗃", shell: "⌨", go: "🐹", csharp: "🔷", c: "🔧", cpp: "🔧", ruby: "💎", php: "🐘", text: "📄" };

export function iconFor(name: string, isDir: boolean, open = false): string {
  if (isDir) return open ? "📂" : "📁";
  if (/\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(name)) return "🖼";
  if (/\.(zip|gz|tar|7z|rar)$/i.test(name)) return "🗜";
  if (/lock(\.json|\.yaml)?$/i.test(name)) return "🔒";
  return ICONS[languageFor(name)] ?? "📄";
}

// ---------------------------------------------------------------- git decorations

export interface Decor {
  letter: string;
  kind: string;
  staged: boolean;
}

const LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", conflicted: "!", untracked: "U" };

/** path -> decoration for files, and folder -> true when anything below changed. */
export function decorations(entries: FileEntry[]): { files: Map<string, Decor>; folders: Set<string> } {
  const files = new Map<string, Decor>();
  const folders = new Set<string>();
  for (const e of entries) {
    files.set(e.path, { letter: LETTER[e.kind] ?? "M", kind: e.kind, staged: e.index !== "." && e.kind !== "untracked" });
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return { files, folders };
}

// ---------------------------------------------------------------- toolbar texts

const ago = (ms: number, now: number): string => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** What the local branch knows about its upstream. Never claims freshness: it always says when the last fetch was. */
export function syncText(s: RepoState, now = Date.now()): { text: string; level: "ok" | "info" | "warn" } {
  if (!s.isRepo) return { text: "Not a Git repository", level: "warn" };
  const b = s.branch;
  const when = s.lastFetchMs ? `last fetched ${ago(s.lastFetchMs, now)}` : "never fetched";
  if (b.detached) return { text: "Detached HEAD (not on a branch)", level: "warn" };
  if (!b.upstream) return { text: "No upstream branch", level: "info" };
  if (b.ahead === 0 && b.behind === 0) {
    return s.lastFetchMs
      ? { text: `Up to date with ${b.upstream} as of the last fetch ${ago(s.lastFetchMs, now)}`, level: "ok" }
      : { text: `Up to date with ${b.upstream} (never fetched here, so this may be stale)`, level: "info" };
  }
  if (b.behind === 0) return { text: `${b.ahead} ahead of ${b.upstream} (${when})`, level: "info" };
  if (b.ahead === 0) return { text: `${b.behind} behind ${b.upstream} (${when})`, level: "warn" };
  return { text: `Diverged: ${b.ahead} ahead, ${b.behind} behind ${b.upstream} (${when})`, level: "warn" };
}

export const changeSummary = (s: RepoState): string => (s.clean ? "Working tree clean" : `${s.modified} modified · ${s.staged} staged · ${s.untracked} untracked${s.conflicted ? ` · ${s.conflicted} conflicted` : ""}`);

// ---------------------------------------------------------------- graph drawing geometry

export const GRAPH = { rowH: 26, laneW: 14, pad: 9, radius: 4.5 };
export const LANE_COLORS = ["#3cc0bb", "#f0b93a", "#e0584d", "#9677d6", "#7fd36a", "#e8a13a", "#6fa8e8", "#d77fb3"];
export const laneX = (lane: number): number => GRAPH.pad + lane * GRAPH.laneW;
export const laneColor = (c: number): string => LANE_COLORS[c % LANE_COLORS.length] ?? "#3cc0bb";

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

/** Line segments of one graph row in row-local coordinates (0..rowH). */
export function rowSegments(r: Pick<GraphRow, "lane" | "through" | "incoming" | "outgoing" | "color">): Segment[] {
  const h = GRAPH.rowH;
  const mid = h / 2;
  const seg: Segment[] = [];
  for (const t of r.through) seg.push({ x1: laneX(t.lane), y1: 0, x2: laneX(t.lane), y2: h, color: laneColor(t.color) });
  for (const i of r.incoming) seg.push({ x1: laneX(i.lane), y1: 0, x2: laneX(r.lane), y2: mid, color: laneColor(i.color) });
  for (const o of r.outgoing) seg.push({ x1: laneX(r.lane), y1: mid, x2: laneX(o.lane), y2: h, color: laneColor(o.color) });
  return seg;
}

export const graphWidth = (maxLanes: number): number => GRAPH.pad * 2 + Math.max(1, maxLanes) * GRAPH.laneW;
