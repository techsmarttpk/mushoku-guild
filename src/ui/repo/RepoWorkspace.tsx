import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGE_LABEL, applyStats, closeTab, dirtyTabs, fileName, languageFor, markReloaded, markSaved, nextActive, openTab, setDirty, type EditorTab } from "../../domain/repo.ts";
import type { BranchInfo, FileEntry, GitOp, OpResult, OutputLine, RepoState } from "../../domain/types.ts";
import { api, toProviderError } from "../../ipc.ts";
import { RepoTag } from "../Extras.tsx";
import { Explorer } from "./Explorer.tsx";
import { GitBar } from "./GitBar.tsx";
import { ChangesPanel, DiffView, GitSidebar, GraphView } from "./GitPanels.tsx";
import { OutputPanel } from "./OutputPanel.tsx";
import { ConfirmDialog, EditorHost, type EditorApi } from "./common.tsx";
import type { Project } from "../../domain/types.ts";

const LABEL: Record<string, string> = { fetch: "Fetching", pull: "Pulling", push: "Pushing", switch: "Switching branch", commit: "Committing", merge: "Merging", rebase: "Rebasing", stage: "Staging", unstage: "Unstaging", discard: "Discarding", stash_push: "Stashing" };

type Center = "editor" | "graph" | "diff";
type Side = "files" | "changes" | "git";

export function RepoWorkspace(props: {
  project: Project;
  repo: RepoState | null;
  output: OutputLine[];
  claudeLines: string[];
  trusted: boolean;
  onRepoState: (s: RepoState) => void;
  onClearOutput: () => void;
  /** number of editor tabs with unsaved changes (the shell warns before switching repository or closing) */
  onDirtyCount: (n: number) => void;
}) {
  const { project, repo } = props;
  const pid = project.id;
  const editor = useRef<EditorApi>(null);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [wrap, setWrap] = useState(false);
  const [center, setCenter] = useState<Center>("editor");
  const [side, setSide] = useState<Side>("files");
  const [diff, setDiff] = useState<{ title: string; text: string } | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fsKey, setFsKey] = useState(0);
  const [histKey, setHistKey] = useState(0);
  const [sideW, setSideW] = useState(250);
  const [outH, setOutH] = useState(150);
  const [outOpen, setOutOpen] = useState(true);
  const [closing, setClosing] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const loadedPid = useRef<number | null>(null);

  // ---- authoritative Git state: the backend pushes it; we subscribe and also prime it
  useEffect(() => {
    void api.gitWatch(pid).catch(() => undefined);
    void api.gitState(pid).then(props.onRepoState, () => undefined);
    return () => {
      void api.gitWatch(null).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const sig = useMemo(() => (repo ? `${repo.historyToken}|${repo.entries.map((e) => e.kind + e.path).join(",")}|${repo.branch.head}` : ""), [repo]);
  const token = repo?.historyToken ?? "";
  useEffect(() => {
    setFsKey((k) => k + 1);
  }, [sig]);
  useEffect(() => {
    setHistKey((k) => k + 1);
  }, [token]);

  const loadBranches = useCallback(() => {
    void api.gitBranches(pid).then(setBranches, () => undefined);
  }, [pid]);
  useEffect(() => {
    loadBranches();
  }, [loadBranches, token]);

  // ---- editor files
  const openFile = useCallback(
    async (rel: string): Promise<void> => {
      setCenter("editor");
      setNote(null);
      if (tabsRef.current.some((t) => t.rel === rel)) {
        setActive(rel);
        editor.current?.show(rel);
        editor.current?.focus();
        return;
      }
      try {
        const f = await api.fsRead(pid, rel);
        await editor.current?.ensure(rel, f.content, languageFor(rel));
        setTabs((t) => openTab(t, { rel, mtime: f.mtime, crlf: f.crlf }));
        setActive(rel);
        editor.current?.show(rel);
        editor.current?.focus();
        if (f.large) setNote(`${rel} is large (${Math.round(f.size / 1024)} KB): highlighting may be slow.`);
      } catch (e) {
        setNote(toProviderError(e).message);
      }
    },
    [pid],
  );

  const reloadFile = useCallback(
    async (rel: string): Promise<void> => {
      try {
        const f = await api.fsRead(pid, rel);
        editor.current?.replace(rel, f.content);
        setTabs((t) => markReloaded(t, rel, f.mtime));
      } catch (e) {
        setNote(toProviderError(e).message);
      }
    },
    [pid],
  );

  const save = useCallback(
    async (rel: string, force = false): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.rel === rel);
      const text = editor.current?.text(rel);
      if (!tab || text == null) return false;
      try {
        const r = await api.fsWrite(pid, rel, text, tab.crlf, tab.mtime, force);
        if (r.conflict) {
          setTabs((t) => t.map((x) => (x.rel === rel ? { ...x, external: "changed" as const } : x)));
          setOverwrite(rel);
          return false;
        }
        editor.current?.markSaved(rel);
        setTabs((t) => markSaved(t, rel, r.mtime));
        setStatus({ text: `Saved ${rel}`, error: false });
        return true;
      } catch (e) {
        setStatus({ text: `Could not save ${rel}: ${toProviderError(e).message}`, error: true });
        return false;
      }
    },
    [pid],
  );
  const saveActive = useCallback(() => {
    if (activeRef.current) void save(activeRef.current);
  }, [save]);
  const saveAll = useCallback(async () => {
    for (const t of dirtyTabs(tabsRef.current)) await save(t.rel);
  }, [save]);

  const closeNow = (rel: string): void => {
    const next = nextActive(tabsRef.current, rel, activeRef.current);
    editor.current?.close(rel);
    setTabs((t) => closeTab(t, rel));
    setActive(next);
    if (next) editor.current?.show(next);
  };
  const requestClose = (rel: string): void => (tabsRef.current.find((t) => t.rel === rel)?.dirty ? setClosing(rel) : closeNow(rel));

  // ---- detect external modifications (a quest, Git, another editor): poll the open files
  const checkDisk = useCallback(async (): Promise<void> => {
    const rels = tabsRef.current.map((t) => t.rel);
    if (rels.length === 0) return;
    try {
      const stats = await api.fsStat(pid, rels);
      const { tabs: next, reload } = applyStats(tabsRef.current, stats);
      setTabs(next);
      for (const r of reload) {
        await reloadFile(r);
        setStatus({ text: `${r} changed on disk and was reloaded`, error: false });
      }
    } catch {
      /* the next poll retries */
    }
  }, [pid, reloadFile]);
  useEffect(() => {
    const t = setInterval(() => void checkDisk(), 3000);
    return () => clearInterval(t);
  }, [checkDisk]);
  useEffect(() => {
    void checkDisk();
  }, [sig, checkDisk]);

  // ---- dirty bookkeeping and workspace persistence
  useEffect(() => {
    props.onDirtyCount(dirtyTabs(tabs).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);
  useEffect(() => {
    if (!restored || loadedPid.current !== pid) return;
    const t = setTimeout(() => void api.workspaceSave(pid, JSON.stringify({ tabs: tabs.map((x) => x.rel), active })).catch(() => undefined), 600);
    return () => clearTimeout(t);
  }, [tabs, active, restored, pid]);
  useEffect(() => {
    let live = true;
    setRestored(false);
    setTabs([]);
    setActive(null);
    setDiff(null);
    setCenter("editor");
    void (async () => {
      try {
        const raw = await api.workspaceGet(pid);
        const ws = raw ? (JSON.parse(raw) as { tabs?: string[]; active?: string | null }) : null;
        loadedPid.current = pid;
        for (const rel of ws?.tabs ?? []) {
          if (!live) return;
          await openFile(rel);
        }
        if (live && ws?.active && (ws.tabs ?? []).includes(ws.active)) await openFile(ws.active);
      } catch {
        /* a missing or corrupt workspace record just means an empty editor */
      }
      if (live) setRestored(true);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // ---- Git operations
  const run = useCallback(
    async (op: GitOp, confirmed = false): Promise<OpResult | null> => {
      setBusy(LABEL[op.op] ?? op.op.replace(/_/g, " "));
      setStatus(null);
      try {
        const r = await api.gitOp(pid, op, confirmed);
        setStatus({ text: r.summary, error: !r.ok });
        loadBranches();
        void api.gitState(pid).then(props.onRepoState, () => undefined);
        void checkDisk();
        if (r.conflicts) setSide("changes");
        return r;
      } catch (e) {
        setStatus({ text: toProviderError(e).message, error: true });
        return null;
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pid, loadBranches, checkDisk],
  );
  useEffect(() => {
    if (!status || status.error) return;
    const t = setTimeout(() => setStatus(null), 9000);
    return () => clearTimeout(t);
  }, [status]);

  const openDiff = async (e: FileEntry, staged: boolean): Promise<void> => {
    try {
      const text = await api.gitDiff(pid, { kind: staged ? "staged" : "unstaged", path: e.path });
      setDiff({ title: `${staged ? "Staged" : "Unstaged"} · ${e.path}`, text });
      setCenter("diff");
    } catch (err) {
      setStatus({ text: toProviderError(err).message, error: true });
    }
  };
  const openCommitDiff = async (hash: string, path: string | null, title: string): Promise<void> => {
    try {
      setDiff({ title, text: await api.gitDiff(pid, { kind: "commit", hash, path }) });
      setCenter("diff");
    } catch (err) {
      setStatus({ text: toProviderError(err).message, error: true });
    }
  };

  const onRenamed = (from: string, to: string): void => {
    for (const t of tabsRef.current.filter((x) => x.rel === from || x.rel.startsWith(from + "/"))) closeNow(t.rel);
    void to;
  };
  const onDeleted = (rel: string): void => {
    for (const t of tabsRef.current.filter((x) => x.rel === rel || x.rel.startsWith(rel + "/"))) closeNow(t.rel);
  };

  const dragX = (e: React.PointerEvent): void => {
    const start = e.clientX;
    const w0 = sideW;
    const move = (m: PointerEvent): void => setSideW(Math.min(480, Math.max(180, w0 + m.clientX - start)));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const dragY = (e: React.PointerEvent): void => {
    const start = e.clientY;
    const h0 = outH;
    const move = (m: PointerEvent): void => setOutH(Math.min(420, Math.max(80, h0 - (m.clientY - start))));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const activeTab = tabs.find((t) => t.rel === active) ?? null;
  const changedCount = repo ? repo.entries.length : 0;

  return (
    <div className="repo">
      <div className="repo-top">
        <RepoTag project={project} />
        <GitBar projectId={pid} repoName={project.name} state={repo} branches={branches} busy={busy} status={status} run={run} onRefresh={() => void api.gitState(pid).then(props.onRepoState)} onLoadBranches={loadBranches} onShowChanges={() => setSide("changes")} />
      </div>
      <div className="repo-body" style={{ gridTemplateColumns: `${sideW}px 5px minmax(0,1fr)` }}>
        <aside className="repo-side">
          <div className="side-tabs" role="tablist">
            {(["files", "changes", "git"] as const).map((s) => (
              <button key={s} role="tab" aria-selected={side === s} className={`stab ${side === s ? "on" : ""}`} onClick={() => setSide(s)}>
                {s === "files" ? "Files" : s === "changes" ? `Changes${changedCount ? ` (${changedCount})` : ""}` : "Git"}
              </button>
            ))}
          </div>
          <div className="side-body">
            {side === "files" && <Explorer projectId={pid} refreshKey={fsKey} entries={repo?.entries ?? []} activePath={active} onOpen={(r) => void openFile(r)} onRenamed={onRenamed} onDeleted={onDeleted} onError={(m) => setStatus({ text: m, error: true })} />}
            {side === "changes" && repo && <ChangesPanel projectId={pid} state={repo} busy={busy !== null} run={run} onOpenDiff={(e, s) => void openDiff(e, s)} onOpenFile={(r) => void openFile(r)} />}
            {side === "git" && repo && <GitSidebar projectId={pid} state={repo} refreshKey={histKey} run={run} busy={busy !== null} branches={branches} onLoadBranches={loadBranches} />}
            {side !== "files" && !repo && <div className="muted pad">Reading Git state…</div>}
          </div>
        </aside>
        <div className="splitter" onPointerDown={dragX} role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" />
        <section className="repo-center">
          <div className="center-tabs">
            <div className="etabs" role="tablist">
              {tabs.map((t) => (
                <div key={t.rel} role="tab" aria-selected={t.rel === active && center === "editor"} className={`etab ${t.rel === active && center === "editor" ? "on" : ""}`} title={t.rel + (t.external === "changed" ? " (changed on disk)" : t.external === "deleted" ? " (deleted on disk)" : "")}>
                  <button className="etab-name" onClick={() => { setCenter("editor"); setActive(t.rel); editor.current?.show(t.rel); editor.current?.focus(); }}>
                    {fileName(t.rel)}
                    {t.dirty && <span className="dirty-dot" title="Unsaved changes"> ●</span>}
                    {t.external !== "none" && <span className="ext-flag" title="Changed outside the editor"> ⚠</span>}
                  </button>
                  <button className="etab-x" aria-label={`Close ${t.rel}`} onClick={() => requestClose(t.rel)}>×</button>
                </div>
              ))}
              {tabs.length === 0 && <span className="muted small pad">Open a file from the explorer.</span>}
            </div>
            <div className="center-switch">
              <button className={`seg ${center === "editor" ? "on" : ""}`} onClick={() => setCenter("editor")}>Editor</button>
              <button className={`seg ${center === "graph" ? "on" : ""}`} onClick={() => setCenter("graph")}>Graph</button>
              {diff && <button className={`seg ${center === "diff" ? "on" : ""}`} onClick={() => setCenter("diff")}>Diff</button>}
            </div>
          </div>
          {activeTab && center === "editor" && (
            <div className="editor-bar">
              <span className="mono">{activeTab.rel}</span>
              <span className="grow" />
              <button className="btn btn-quiet" onClick={() => void save(activeTab.rel)} disabled={!activeTab.dirty} title="Ctrl+S">Save</button>
              <button className="btn btn-quiet" onClick={() => void saveAll()} disabled={dirtyTabs(tabs).length === 0} title="Ctrl+Shift+S">Save all</button>
              <button className="btn btn-quiet" onClick={() => void reloadFile(activeTab.rel)} title="Re-read the file from disk" disabled={activeTab.dirty}>Reload</button>
              <label className="small"><input type="checkbox" checked={wrap} onChange={(e) => { setWrap(e.target.checked); editor.current?.setWrap(e.target.checked); }} /> wrap</label>
            </div>
          )}
          {activeTab && center === "editor" && activeTab.external !== "none" && (
            <div className="ext-banner" role="alert">
              {activeTab.external === "deleted" ? "This file was deleted on disk. Your buffer is kept; saving recreates it." : "This file changed on disk while you have unsaved edits."}
              <button className="btn" onClick={() => void reloadFile(activeTab.rel)}>Reload from disk (discard my edits)</button>
              <button className="btn btn-quiet" onClick={() => setTabs((t) => t.map((x) => (x.rel === activeTab.rel ? { ...x, external: "none" } : x)))}>Keep my version</button>
            </div>
          )}
          {note && center === "editor" && <div className="note">{note} <button className="link" onClick={() => setNote(null)}>dismiss</button></div>}
          <div className="center-body">
            <div className="editor-wrap" style={{ display: center === "editor" ? "block" : "none" }}>
              <EditorHost ref={editor} onDirty={(r, d) => setTabs((t) => setDirty(t, r, d))} onCursor={(line, col) => setCursor({ line, col })} onSave={saveActive} onSaveAll={() => void saveAll()} />
              {!activeTab && <div className="editor-empty muted">Select a file in the explorer. Ctrl+S saves, Ctrl+F searches, Ctrl+H replaces.</div>}
            </div>
            {center === "graph" && <GraphView projectId={pid} refreshKey={histKey} onOpenDiff={(h, p, t) => void openCommitDiff(h, p, t)} />}
            {center === "diff" && diff && <DiffView title={diff.title} text={diff.text} onClose={() => setCenter("editor")} />}
          </div>
          {activeTab && center === "editor" && (
            <div className="statusbar">
              <span>Ln {cursor.line}, Col {cursor.col}</span>
              <span>{LANGUAGE_LABEL[languageFor(activeTab.rel)] ?? "Plain text"}</span>
              <span>{activeTab.crlf ? "CRLF" : "LF"}</span>
              <span>UTF-8</span>
              <span className="grow" />
              <span>{activeTab.dirty ? "● unsaved" : "saved"}</span>
            </div>
          )}
        </section>
      </div>
      <div className="repo-out" style={{ height: outOpen ? outH : 28 }}>
        <div className="out-handle" onPointerDown={outOpen ? dragY : undefined} role="separator" aria-orientation="horizontal" aria-label="Resize the output panel">
          <button className="link" onClick={() => setOutOpen((o) => !o)}>{outOpen ? "▾ Output" : "▸ Output"}</button>
        </div>
        {outOpen && <OutputPanel projectId={pid} lines={props.output} claudeLines={props.claudeLines} trusted={props.trusted} onClear={props.onClearOutput} />}
      </div>

      {closing && (
        <ConfirmDialog
          title={`Unsaved changes in ${fileName(closing)}`}
          confirm="Save and close"
          message={<p>{closing} has changes that are not saved to disk.</p>}
          secondary={{ label: "Discard changes", onClick: () => { const r = closing; setClosing(null); closeNow(r); } }}
          onCancel={() => setClosing(null)}
          onConfirm={async () => {
            const r = closing;
            setClosing(null);
            if (await save(r)) closeNow(r);
          }}
        />
      )}
      {overwrite && (
        <ConfirmDialog
          title="File changed on disk"
          danger
          confirm="Overwrite with my version"
          message={<p><strong>{overwrite}</strong> was modified outside the editor (a quest, Git or another program) after you opened it. Saving now would replace those changes. Nothing was written.</p>}
          secondary={{ label: "Reload from disk (discard mine)", onClick: () => { const r = overwrite; setOverwrite(null); void reloadFile(r); } }}
          onCancel={() => setOverwrite(null)}
          onConfirm={() => { const r = overwrite; setOverwrite(null); void save(r, true); }}
        />
      )}
    </div>
  );
}
