import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStats, changeSummary, closeTab, decorations, dirtyTabs, iconFor, languageFor, laneX, markSaved, nextActive, openTab, rowSegments, setDirty, syncText, type EditorTab } from "./repo.ts";
import type { FileEntry, RepoState } from "./types.ts";

const tab = (o: Partial<EditorTab> & { rel: string }): EditorTab => ({ mtime: 100, dirty: false, crlf: false, external: "none", ...o });

test("opening the same file twice keeps one tab; unsaved changes survive switching tabs", () => {
  let tabs = openTab([], { rel: "a.ts", mtime: 1, crlf: false });
  tabs = openTab(tabs, { rel: "b.ts", mtime: 1, crlf: false });
  tabs = openTab(tabs, { rel: "a.ts", mtime: 9, crlf: false });
  assert.equal(tabs.length, 2);
  tabs = setDirty(tabs, "a.ts", true);
  tabs = openTab(tabs, { rel: "c.ts", mtime: 1, crlf: false });
  assert.deepEqual(dirtyTabs(tabs).map((t) => t.rel), ["a.ts"], "opening or activating other tabs never clears unsaved state");
  tabs = markSaved(tabs, "a.ts", 55);
  assert.deepEqual([tabs[0]?.dirty, tabs[0]?.mtime], [false, 55]);
});

test("an external change silently refreshes a clean tab but never a tab with unsaved edits", () => {
  const tabs = [tab({ rel: "clean.ts" }), tab({ rel: "dirty.ts", dirty: true }), tab({ rel: "same.ts" }), tab({ rel: "gone.ts", dirty: true })];
  const { tabs: next, reload } = applyStats(tabs, [
    { rel: "clean.ts", mtime: 200, exists: true },
    { rel: "dirty.ts", mtime: 200, exists: true },
    { rel: "same.ts", mtime: 100, exists: true },
    { rel: "gone.ts", mtime: 0, exists: false },
  ]);
  assert.deepEqual(reload, ["clean.ts"]);
  const by = (r: string) => next.find((t) => t.rel === r)!;
  assert.equal(by("dirty.ts").external, "changed");
  assert.equal(by("dirty.ts").dirty, true, "the user's edits are still there");
  assert.equal(by("same.ts").external, "none");
  assert.deepEqual([by("gone.ts").external, by("gone.ts").dirty], ["deleted", true], "a deleted file keeps its unsaved buffer");
});

test("closing the active tab activates a neighbour", () => {
  const tabs = [tab({ rel: "a" }), tab({ rel: "b" }), tab({ rel: "c" })];
  assert.equal(nextActive(tabs, "b", "b"), "a");
  assert.equal(nextActive(tabs, "a", "a"), "b");
  assert.equal(nextActive(tabs, "c", "a"), "a");
  assert.equal(nextActive([tab({ rel: "a" })], "a", "a"), null);
  assert.equal(closeTab(tabs, "b").length, 2);
});

test("languages and icons cover the requested stack", () => {
  const expect: Record<string, string> = { "a.ts": "typescript", "a.tsx": "tsx", "a.js": "javascript", "a.jsx": "jsx", "a.py": "python", "A.java": "java", "a.kt": "kotlin", "a.rs": "rust", "a.html": "html", "a.css": "css", "a.json": "json", "a.yml": "yaml", "Cargo.toml": "toml", "README.md": "markdown", "q.sql": "sql", "run.sh": "shell", Dockerfile: "shell", "noext": "text" };
  for (const [p, l] of Object.entries(expect)) assert.equal(languageFor(`src/${p}`), l, p);
  assert.equal(iconFor("src", true, false), "📁");
  assert.equal(iconFor("src", true, true), "📂");
  assert.equal(iconFor("main.rs", false), "🦀");
  assert.equal(iconFor("logo.png", false), "🖼");
});

const E = (path: string, kind: string, index = ".", worktree = "M"): FileEntry => ({ path, orig: null, index, worktree, kind });

test("git status decorates files and every folder above them", () => {
  const d = decorations([E("src/ui/a.ts", "modified"), E("docs/new.md", "untracked", ".", "?"), E("x.ts", "added", "A", ".")]);
  assert.deepEqual([d.files.get("src/ui/a.ts")?.letter, d.files.get("docs/new.md")?.letter, d.files.get("x.ts")?.letter], ["M", "U", "A"]);
  assert.equal(d.files.get("x.ts")?.staged, true);
  assert.deepEqual([...d.folders].sort(), ["docs", "src", "src/ui"]);
});

const state = (o: Partial<RepoState["branch"]>, fetched: number | null, extra: Partial<RepoState> = {}): RepoState => ({
  isRepo: true, root: "", branch: { head: "main", oid: "abc", detached: false, upstream: "origin/main", ahead: 0, behind: 0, ...o }, entries: [], staged: 0, modified: 0, untracked: 0, conflicted: 0, clean: true, operation: null, lastFetchMs: fetched, historyToken: "t", error: null, ...extra,
});

test("the sync text never claims freshness it does not have", () => {
  const now = 1_000_000_000;
  assert.match(syncText(state({}, null), now).text, /Up to date.*never fetched/);
  assert.equal(syncText(state({}, null), now).level, "info", "up to date without any fetch is not shown as a green success");
  assert.match(syncText(state({}, now - 5 * 60000), now).text, /as of the last fetch 5 min ago/);
  assert.equal(syncText(state({}, now - 5 * 60000), now).level, "ok");
  assert.match(syncText(state({ behind: 3 }, now - 60000), now).text, /3 behind origin\/main/);
  assert.match(syncText(state({ ahead: 1, behind: 2 }, now), now).text, /Diverged: 1 ahead, 2 behind/);
  assert.match(syncText(state({ upstream: null }, null), now).text, /No upstream/);
  assert.match(syncText(state({ detached: true }, null), now).text, /Detached/);
  assert.equal(changeSummary(state({}, null, { clean: false, modified: 2, staged: 1, untracked: 3 })), "2 modified · 1 staged · 3 untracked");
});

test("graph rows draw pass-through, converging and fan-out lines on the right lanes", () => {
  const seg = rowSegments({ lane: 0, color: 0, through: [{ lane: 2, color: 3 }], incoming: [{ lane: 1, color: 1 }], outgoing: [{ lane: 0, color: 0 }, { lane: 1, color: 1 }] });
  assert.equal(seg.length, 4);
  const through = seg[0]!;
  assert.deepEqual([through.x1, through.x2, through.y1 < through.y2], [laneX(2), laneX(2), true]);
  const incoming = seg[1]!;
  assert.deepEqual([incoming.x1, incoming.x2], [laneX(1), laneX(0)]);
  const fan = seg.filter((s) => s.y1 > 0);
  assert.deepEqual(fan.map((s) => s.x2).sort(), [laneX(0), laneX(1)].sort());
});
