import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CafeScene, SCENE_H, SCENE_W } from "./cafe/CafeScene.ts";
import { LibraryScene } from "./cafe/LibraryScene.ts";
import { projectScene } from "./domain/scene.ts";
import { neighbour } from "./domain/shelf.ts";
import { initialState, reduce } from "./domain/store.ts";
import { type DocContent, type LibraryMeta, type Model, type Policy, type Project, type ProviderError, type BrowserStatus } from "./domain/types.ts";
import { createWelcomeGate, pickWelcome } from "./domain/welcome.ts";
import { api, onAppEvent, onWindowMinimized, toProviderError } from "./ipc.ts";
import { ChatPanel } from "./ui/ChatPanel.tsx";
import { BrowserCard, PermissionsCard, RepoTag, ServicesPanel } from "./ui/Extras.tsx";
import { LibraryReader } from "./ui/Library.tsx";
import { ActivityFeed, ErrorNote, GuildPanel, NewTask, PermissionDialog, TaskView } from "./ui/panels.tsx";
import { QuestHistory } from "./ui/Quests.tsx";

/** One greeting per application launch; React re-renders and effect re-runs cannot repeat it. */
const welcomeGate = createWelcomeGate();

type Tab = "quest" | "chat" | "library" | "guild";
const TAB_LABEL: Record<Tab, string> = { quest: "Quests", chat: "Chat", library: "Library", guild: "Guild" };

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [tab, setTab] = useState<Tab>("guild");
  const [newQuest, setNewQuest] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [authError, setAuthError] = useState<ProviderError | null>(null);
  const [policy, setPolicy] = useState<Policy>("ask_each");
  /** Effective permission mode of the quest being prepared; initialised from the repository's saved profile. */
  const [autopilotChoice, setAutopilotChoice] = useState(false);
  const [remember, setRemember] = useState(true);
  const [chatQuery, setChatQuery] = useState("");
  const [browser, setBrowser] = useState<BrowserStatus | null>(null);
  const [scale, setScale] = useState(2);
  // library
  const [libDocs, setLibDocs] = useState<LibraryMeta[]>([]);
  const [libDoc, setLibDoc] = useState<DocContent | null>(null);
  const [libHover, setLibHover] = useState(-1);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const libHostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CafeScene | null>(null);
  const libRef = useRef<LibraryScene | null>(null);
  const minimized = useRef(false);

  const project = useMemo(() => state.projects.find((p) => p.id === state.currentProjectId) ?? null, [state.projects, state.currentProjectId]);
  const pid = state.currentProjectId;
  const permission = state.permissions[0] ?? null;
  const status = state.detail?.task.status ?? null;
  const claudeReady = !!state.claude?.path && !state.claude.error;

  const fail = useCallback((e: unknown) => dispatch({ type: "patch", patch: { error: toProviderError(e) } }), []);
  const run = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key);
      try {
        await fn();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [fail],
  );

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      off = await onAppEvent((event) => dispatch({ type: "event", event }));
      if (cancelled) off();
      try {
        const snap = await api.snapshot();
        const current = Number(snap.settings["current_project_id"] ?? "");
        const currentProjectId = snap.projects.some((p) => p.id === current) ? current : (snap.projects[0]?.id ?? null);
        dispatch({ type: "patch", patch: { projects: snap.projects, settings: snap.settings, dbNote: snap.dbNote, chatgpt: snap.chatgpt, currentProjectId } });
        setTab(snap.chatgpt.connected ? "quest" : "guild");
      } catch (e) {
        fail(e);
      }
      try {
        dispatch({ type: "patch", patch: { claude: await api.claudeDetect() } });
      } catch (e) {
        fail(e);
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [fail]);

  // ---------------------------------------------------------------- per-repository data (re-loaded on every switch)
  const loadContext = useCallback(async (projectId: number | null, refresh: boolean) => {
    if (projectId === null) {
      dispatch({ type: "patch", patch: { context: null, contextBusy: false } });
      return;
    }
    dispatch({ type: "patch", patch: { contextBusy: true } });
    try {
      dispatch({ type: "patch", patch: { context: await api.projectContext(projectId, refresh), contextBusy: false } });
    } catch (e) {
      dispatch({ type: "patch", patch: { contextBusy: false, context: { status: "unavailable", text: "", collectedAt: Date.now(), sources: [], truncated: false, error: toProviderError(e).message } } });
    }
  }, []);
  const reloadQuests = useCallback(async (projectId: number | null) => {
    if (projectId === null) return;
    try {
      const [quests, tasks] = await Promise.all([api.questHistory(projectId), api.taskList(projectId)]);
      dispatch({ type: "patch", patch: { quests, tasks } });
    } catch {
      /* the history refreshes again on the next change */
    }
  }, []);
  const reloadPrefs = useCallback(async (projectId: number | null) => {
    if (projectId === null) return;
    try {
      dispatch({ type: "patch", patch: { prefs: await api.repoPrefsGet(projectId) } });
    } catch {
      /* shown as "not loaded" */
    }
  }, []);
  const openChatFor = useCallback(async (projectId: number | null) => {
    if (projectId === null) return;
    try {
      const c = await api.chatOpen(projectId);
      dispatch({ type: "chat_opened", conversation: c.conversation, messages: c.messages, research: c.research });
    } catch (e) {
      dispatch({ type: "patch", patch: { chatError: toProviderError(e) } });
    }
  }, []);

  useEffect(() => {
    if (pid === null) return;
    void reloadQuests(pid);
    void reloadPrefs(pid);
    void loadContext(pid, false);
    void openChatFor(pid);
    setLibDocs([]);
    setLibDoc(null);
    setNewQuest(false);
    setChatQuery("");
  }, [pid, reloadQuests, reloadPrefs, loadContext, openChatFor]);

  // conversation list: per repository, filtered by the search box
  useEffect(() => {
    if (pid === null) return;
    const t = setTimeout(() => {
      void api.chatList(pid, chatQuery).then((convs) => dispatch({ type: "patch", patch: { convs } }), () => undefined);
    }, chatQuery ? 200 : 0);
    return () => clearTimeout(t);
  }, [pid, chatQuery, state.conversation?.id, state.conversation?.title, state.chatMessages.length]);

  // permission defaults come from the repository's saved profile; every quest starts from them explicitly
  useEffect(() => {
    const p = state.prefs;
    if (!p) return;
    if (p.trust === "trusted") {
      setPolicy(p.policy);
      setAutopilotChoice(p.autopilot);
    } else {
      const saved = state.settings["policy"];
      setPolicy(saved === "read_only" || saved === "ask_each" || saved === "accept_edits" ? saved : "ask_each");
      setAutopilotChoice(false);
    }
    setRemember(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.prefs, state.selectedTaskId]);

  // ---------------------------------------------------------------- café scene
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new CafeScene();
    sceneRef.current = scene;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const sync = (): void => scene.setPaused(document.hidden || minimized.current);
    document.addEventListener("visibilitychange", sync);
    void (async () => {
      await scene.init(host);
      if (cancelled) return;
      sync();
      if (welcomeGate()) scene.welcome(pickWelcome(Math.random));
      unlisten = await onWindowMinimized((m) => {
        minimized.current = m;
        sync();
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      document.removeEventListener("visibilitychange", sync);
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);
  const sceneState = useMemo(
    () => projectScene({ status, streaming: state.streaming, permissionPending: state.permissions.length > 0, currentTool: state.currentTool, researching: state.research?.status === "researching" || state.chatResearching !== null, chatting: state.chatStreaming }),
    [status, state.streaming, state.permissions.length, state.currentTool, state.research?.status, state.chatStreaming, state.chatResearching],
  );
  useEffect(() => {
    sceneRef.current?.setState(sceneState);
  }, [sceneState]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(Math.max(1, Math.floor((el.clientWidth / SCENE_W) * 4) / 4), 3.5)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- Library (bookshelf scene lives only while its tab is open)
  const loadShelves = useCallback(async () => {
    if (pid === null) return;
    setLibError(null);
    try {
      setLibDocs(await api.libraryList(pid));
    } catch (e) {
      setLibDocs([]);
      setLibError(toProviderError(e).message);
    }
  }, [pid]);
  useEffect(() => {
    if (tab !== "library" || pid === null) return;
    void loadShelves();
  }, [tab, pid, loadShelves]);
  const openDoc = useCallback(
    async (path: string) => {
      if (pid === null) return;
      setLibLoading(true);
      setLibError(null);
      try {
        setLibDoc(await api.libraryRead(pid, path));
      } catch (e) {
        setLibError(toProviderError(e).message);
      } finally {
        setLibLoading(false);
      }
    },
    [pid],
  );
  const docsRef = useRef(libDocs);
  docsRef.current = libDocs;
  useEffect(() => {
    const host = libHostRef.current;
    if (tab !== "library" || !host) return;
    const scene = new LibraryScene();
    libRef.current = scene;
    let cancelled = false;
    scene.onHover((i) => setLibHover(i));
    scene.onSelect((i) => {
      const d = docsRef.current[i];
      if (d) void openDoc(d.path);
    });
    void (async () => {
      await scene.init(host);
      if (!cancelled) scene.setDocs(docsRef.current, null);
    })();
    return () => {
      cancelled = true;
      libRef.current = null;
      scene.destroy();
    };
  }, [tab, openDoc]);
  useEffect(() => {
    libRef.current?.setDocs(libDocs, libDoc?.path ?? null);
  }, [libDocs, libDoc?.path]);
  const onShelfKey = (e: React.KeyboardEvent): void => {
    const map: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const dir = map[e.key];
    if (dir) {
      e.preventDefault();
      const cur = libDoc ? libDocs.findIndex((d) => d.path === libDoc.path) : libHover;
      const next = neighbour(cur, dir, libDocs.length);
      if (next >= 0) {
        libRef.current?.setSelectedIndex(next);
        setLibHover(next);
      }
    } else if (e.key === "Enter" && libHover >= 0) {
      const d = libDocs[libHover];
      if (d) void openDoc(d.path);
    } else if (e.key === "Escape") setLibDoc(null);
  };
  const askAboutDoc = (useCurrent: boolean) =>
    run("library", async () => {
      if (pid === null || !libDoc) return;
      const res = await api.libraryAsk(pid, libDoc.path, useCurrent ? (state.conversation?.id ?? null) : null);
      dispatch({ type: "chat_opened", conversation: res.open.conversation, messages: res.open.messages, research: res.open.research });
      dispatch({ type: "patch", patch: { chatStreaming: true, chatGeneration: res.generation } });
      setTab("chat");
    });

  // ---------------------------------------------------------------- quests
  const openTask = useCallback(
    async (id: number) => {
      try {
        dispatch({ type: "select_task", detail: await api.taskGet(id) });
        setNewQuest(false);
        setTab("quest");
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );
  const generate = useCallback(
    async (taskId: number, note: string | null) => {
      try {
        dispatch({ type: "generation_started", generation: await api.reasonerGenerate(taskId, note) });
        setTab("quest");
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );
  const submitTask = (title: string, description: string) =>
    run("task", async () => {
      if (!project) return;
      const t = await api.taskCreate(project.id, title, description);
      await reloadQuests(project.id);
      dispatch({ type: "select_task", detail: await api.taskGet(t.id) });
      setNewQuest(false);
      if (state.chatgpt.connected) await generate(t.id, null);
    });
  const approve = (body: string) =>
    run("approve", async () => {
      const d = state.detail;
      let draft = d?.drafts.at(-1);
      if (!d || !draft) return;
      if (body.trim() !== draft.body.trim()) draft = await api.promptSave(d.task.id, body);
      await api.promptApprove(d.task.id, draft.id);
      dispatch({ type: "select_task", detail: await api.taskGet(d.task.id) });
    });
  const rerun = () =>
    run("retry", async () => {
      const d = state.detail;
      const approved = d?.drafts.filter((x) => x.approved).at(-1);
      if (!d || !approved) return;
      await api.promptApprove(d.task.id, approved.id);
      dispatch({ type: "select_task", detail: await api.taskGet(d.task.id) });
    });
  const startRun = () =>
    run("start", async () => {
      const d = state.detail;
      if (!d) return;
      const changed = !!state.prefs && (policy !== state.prefs.policy || autopilotChoice !== state.prefs.autopilot);
      await api.runStart(d.task.id, policy, autopilotChoice, remember && changed);
      if (remember && changed) await reloadPrefs(pid);
    });
  const trust = () =>
    run("trust", async () => {
      if (pid === null) return;
      dispatch({ type: "patch", patch: { prefs: await api.repoPrefsSave(pid, policy, autopilotChoice) } });
    });
  const revoke = () =>
    run("trust", async () => {
      if (pid === null) return;
      await api.repoPrefsRevoke(pid);
      await reloadPrefs(pid);
    });
  const relink = () =>
    run("trust", async () => {
      if (pid === null) return;
      if (await api.projectRelink(pid)) {
        const snap = await api.snapshot();
        dispatch({ type: "patch", patch: { projects: snap.projects } });
        await Promise.all([reloadPrefs(pid), loadContext(pid, true)]);
      }
    });

  // Rust is the source of truth for a running quest: while the UI shows "running", re-read it, so a missed event can
  // never leave the panel stuck on "Claude Code is working".
  useEffect(() => {
    const id = state.selectedTaskId;
    if (id === null || status !== "running") return;
    const t = setInterval(() => {
      void api.taskGet(id).then(
        (detail) => {
          if (detail.task.status !== "running") dispatch({ type: "select_task", detail });
        },
        () => undefined,
      );
    }, 5000);
    return () => clearInterval(t);
  }, [state.selectedTaskId, status]);

  // refresh stored details and the history whenever the open quest changes state
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const id = state.selectedTaskId;
    if (id === null || status === null) return;
    const prev = lastStatus.current;
    lastStatus.current = status;
    if (prev === null || prev === status) return;
    void api.taskGet(id).then((detail) => dispatch({ type: "patch", patch: { detail } }), () => undefined);
    void reloadQuests(pid);
  }, [status, state.selectedTaskId, pid, reloadQuests]);

  // websites/applications launched by the open quest (separate lifecycle from the quest itself)
  useEffect(() => {
    const id = state.selectedTaskId;
    if (id === null) {
      dispatch({ type: "patch", patch: { services: [] } });
      return;
    }
    let live = true;
    const load = (): void => void api.servicesGet(id).then((services) => live && dispatch({ type: "patch", patch: { services } }), () => undefined);
    load();
    const t = setInterval(load, 6000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [state.selectedTaskId, status]);

  // ---------------------------------------------------------------- chat
  const withChat = (fn: () => Promise<void>) => run("chat", fn);
  const sendChat = (text: string) =>
    withChat(async () => {
      const conv = state.conversation;
      if (!conv) return;
      const generation = await api.chatSend(conv.id, text);
      const now = Date.now();
      dispatch({ type: "chat_sending", generation, message: { id: -now, conversationId: conv.id, role: "user", body: text, createdAt: now, kind: "text", status: "complete" } });
    });
  const openConv = (id: number) =>
    withChat(async () => {
      const c = await api.chatOpenConv(id);
      dispatch({ type: "chat_opened", conversation: c.conversation, messages: c.messages, research: c.research });
    });
  const newConv = () =>
    withChat(async () => {
      if (pid === null) return;
      const c = await api.chatNew(pid);
      dispatch({ type: "chat_opened", conversation: c.conversation, messages: c.messages, research: c.research });
    });
  const renameConv = (id: number, title: string) =>
    withChat(async () => {
      await api.chatRename(id, title);
      if (state.conversation?.id === id) dispatch({ type: "event", event: { type: "chat_title", conversationId: id, title } });
      if (pid !== null) dispatch({ type: "patch", patch: { convs: await api.chatList(pid, chatQuery) } });
    });
  const deleteConv = (id: number) =>
    withChat(async () => {
      await api.chatDelete(id);
      if (pid !== null) {
        if (state.conversation?.id === id) await openChatFor(pid);
        dispatch({ type: "patch", patch: { convs: await api.chatList(pid, chatQuery) } });
      }
    });
  const startResearch = () =>
    run("research", async () => {
      if (pid === null) return;
      dispatch({ type: "patch", patch: { researchActivity: [] } });
      dispatch({ type: "patch", patch: { research: await api.researchStart(pid) } });
    });
  useEffect(() => {
    if (pid === null || state.research?.status !== "researching") return;
    const t = setInterval(() => void api.researchGet(pid).then((r) => dispatch({ type: "patch", patch: { research: r } }), () => undefined), 4000);
    return () => clearInterval(t);
  }, [pid, state.research?.status]);

  // ---------------------------------------------------------------- projects, settings, browser
  const switchProject = (p: Project | null) =>
    run("project", async () => {
      if (p) await api.projectSelect(p.id);
      dispatch({ type: "project_switched", projectId: p ? p.id : null });
    });
  const pickProject = () =>
    run("project", async () => {
      const p = await api.projectPick();
      if (!p) return;
      const snap = await api.snapshot();
      dispatch({ type: "patch", patch: { projects: snap.projects } });
      dispatch({ type: "project_switched", projectId: p.id });
    });
  const setSetting = (key: string, value: string) =>
    run("setting", async () => {
      await api.settingsSet(key, value);
      dispatch({ type: "patch", patch: { settings: { ...state.settings, [key]: value } } });
    });
  const loadBrowser = useCallback(async () => {
    try {
      setBrowser(await api.browserStatus());
    } catch (e) {
      fail(e);
    }
  }, [fail]);
  useEffect(() => {
    if (tab === "guild") void loadBrowser();
  }, [tab, loadBrowser, state.settings["browser_enabled"], state.claude?.path]);

  const trusted = state.prefs?.trust === "trusted";
  const changedFromSaved = !!state.prefs && trusted && (policy !== state.prefs.policy || autopilotChoice !== state.prefs.autopilot);
  const permissionsNode = (
    <PermissionsCard project={project} prefs={state.prefs} policy={policy} autopilot={autopilotChoice} onPolicy={setPolicy} onAutopilot={setAutopilotChoice} onTrust={() => void trust()} onRevoke={() => void revoke()} onRelink={() => void relink()} busy={busy === "trust"} />
  );
  const hoveredDoc = libHover >= 0 ? (libDocs[libHover] ?? null) : null;
  const questOpen = state.detail !== null;

  return (
    <div className="app">
      <header className="top">
        <h1>Mushoku Guild</h1>
        <nav className="tabs" role="tablist">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
              {t === "guild" && (!state.chatgpt.connected || !claudeReady) && <span className="dot" title="Setup needed" />}
            </button>
          ))}
        </nav>
        <div className="chips">
          <span className={`chip ${state.chatgpt.connected ? "ok" : ""}`}>ChatGPT {state.chatgpt.connected ? "●" : "○"}</span>
          <span className={`chip ${claudeReady ? "ok" : ""}`}>Claude {claudeReady ? "●" : "○"}</span>
          {state.projects.length > 0 ? (
            <select className="repo-select" aria-label="Active repository" value={pid ?? ""} onChange={(e) => void switchProject(state.projects.find((p) => p.id === Number(e.target.value)) ?? null)}>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  ⌂ {p.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="chip">no repository</span>
          )}
        </div>
      </header>

      <main className="cols">
        <section className="left">
          <div className="cafe-slot" ref={wrapRef}>
            <div className="cafe" style={{ "--w": `${Math.round(SCENE_W * scale)}px`, "--h": `${Math.round(SCENE_H * scale)}px` } as React.CSSProperties}>
              <div ref={hostRef} className="cafe-canvas" style={{ display: tab === "library" ? "none" : "block" }} />
              {tab === "library" && <div ref={libHostRef} className="library-host" tabIndex={0} onKeyDown={onShelfKey} aria-label="Bookshelf. Arrow keys move between books, Enter opens one." />}
            </div>
          </div>
          <div className="activity panel">
            {tab === "chat" ? (
              <>
                <h2 className="panel-title">Research activity {(state.research?.status === "researching" || state.chatResearching !== null) && <small>· Claude is reading the repository</small>}</h2>
                <ActivityFeed items={state.researchActivity} empty="When ChatGPT asks Claude to investigate (or you press Ask Claude for Context), every file Claude reads appears here. Research is read-only." />
              </>
            ) : tab === "library" ? (
              <>
                <h2 className="panel-title">Shelf <RepoTag project={project} /></h2>
                <div className="muted pad">{hoveredDoc ? `${hoveredDoc.title}  ·  ${hoveredDoc.path}` : libDocs.length ? `${libDocs.length} books. Hover for details, click to read.` : "Nothing on the shelves yet."}</div>
              </>
            ) : (
              <>
                <h2 className="panel-title">Activity {status && <small>· {state.detail?.task.title}</small>}</h2>
                <ActivityFeed items={state.activity} empty="Nothing has happened yet. When Claude Code works, every message, tool call and permission request appears here." />
              </>
            )}
          </div>
        </section>

        <section className={`right panel ${tab === "chat" ? "wide" : ""}`}>
          {state.dbNote && <div className="note">{state.dbNote}</div>}
          {tab === "guild" && (
            <GuildPanel
              state={state}
              models={models}
              busy={busy}
              authError={authError}
              onConnect={() => {
                setAuthError(null);
                void api.chatgptConnect().then(
                  (st) => {
                    dispatch({ type: "patch", patch: { chatgpt: st } });
                    setTab("quest");
                  },
                  (e: unknown) => {
                    const pe = toProviderError(e);
                    if (pe.kind !== "cancelled") setAuthError(pe);
                  },
                );
              }}
              onCancelConnect={() => void api.chatgptCancelConnect()}
              onDisconnect={() => {
                void api.chatgptDisconnect().then(() => {
                  setModels([]);
                  dispatch({ type: "patch", patch: { chatgpt: { connected: false, label: null } } });
                });
              }}
              onLoadModels={() =>
                run("models", async () => {
                  setAuthError(null);
                  try {
                    setModels(await api.chatgptModels());
                  } catch (e) {
                    setAuthError(toProviderError(e));
                    if (toProviderError(e).kind === "auth_expired") dispatch({ type: "patch", patch: { chatgpt: { connected: false, label: null } } });
                  }
                })
              }
              onSetting={(k, v) => void setSetting(k, v)}
              onRecheckClaude={() =>
                run("claude", async () => {
                  dispatch({ type: "patch", patch: { claude: null } });
                  dispatch({ type: "patch", patch: { claude: await api.claudeDetect() } });
                })
              }
              onPickClaude={() =>
                run("claude", async () => {
                  if (await api.claudePickExe()) dispatch({ type: "patch", patch: { claude: await api.claudeDetect() } });
                })
              }
              onRefreshContext={() => void loadContext(pid, true)}
              onPickProject={() => void pickProject()}
              onSelectProject={(p) => void switchProject(p)}
              extra={
                <>
                  <BrowserCard
                    status={browser}
                    busy={busy === "setting"}
                    onToggle={(on) => void setSetting("browser_enabled", on ? "1" : "0")}
                    onInstall={() => void api.browserInstallExtension().catch(fail)}
                    onOpenChrome={() => void api.browserOpenChrome().then(loadBrowser, fail)}
                    onRecheck={() => void loadBrowser()}
                  />
                  {project && (
                    <section className="card">
                      <h3>
                        Permissions <RepoTag project={project} />
                      </h3>
                      <p className="muted small">Remembered per repository, never shared between repositories.</p>
                      {permissionsNode}
                    </section>
                  )}
                </>
              }
            />
          )}

          {tab === "quest" && (
            <div className="stack">
              {questOpen && state.detail ? (
                <>
                  <div className="row">
                    <button className="link" onClick={() => { dispatch({ type: "patch", patch: { selectedTaskId: null, detail: null, activity: [], error: null } }); void reloadQuests(pid); }}>
                      ← Quests
                    </button>
                    <RepoTag project={project} />
                  </div>
                  <TaskView
                    state={state}
                    detail={state.detail}
                    connected={state.chatgpt.connected}
                    claudeReady={claudeReady}
                    policy={policy}
                    onPolicy={setPolicy}
                    autopilotChoice={autopilotChoice}
                    onAutopilotChoice={setAutopilotChoice}
                    onToggleAutopilot={(on) => void api.runSetAutopilot(on).catch(fail)}
                    canStart={trusted}
                    permissionsNode={permissionsNode}
                    rememberNode={
                      changedFromSaved ? (
                        <label className="radio">
                          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                          <span>Remember these permissions for {project?.name ?? "this repository"}</span>
                        </label>
                      ) : null
                    }
                    servicesNode={
                      <ServicesPanel
                        services={state.services}
                        chromeAvailable
                        onOpen={(id, chrome) => void api.serviceOpen(id, chrome).catch(fail)}
                        onStop={(id) => void api.serviceStop(id).then(() => api.servicesGet(state.selectedTaskId ?? 0).then((services) => dispatch({ type: "patch", patch: { services } })), fail)}
                        onFocus={(id) => void api.serviceFocus(id).catch(fail)}
                      />
                    }
                    onGenerate={(note) => void generate(state.detail?.task.id ?? 0, note)}
                    onStopReasoner={() => void api.reasonerCancel()}
                    onApprove={(b) => void approve(b)}
                    onStart={() => void startRun()}
                    onCancelRun={() => void api.runCancel()}
                    onAccept={() =>
                      void run("accept", async () => {
                        if (state.detail) await api.taskAccept(state.detail.task.id);
                      })
                    }
                    onRetry={() => void rerun()}
                  />
                </>
              ) : newQuest ? (
                <>
                  <button className="link" onClick={() => setNewQuest(false)}>
                    ← Quests
                  </button>
                  <NewTask project={project} context={state.context} contextBusy={state.contextBusy} connected={state.chatgpt.connected} onSubmit={(t, d) => void submitTask(t, d)} busy={busy === "task"} />
                  <ErrorNote error={state.error} onDismiss={() => dispatch({ type: "patch", patch: { error: null } })} />
                </>
              ) : (
                <>
                  <QuestHistory project={project} quests={state.quests} selectedId={state.selectedTaskId} onOpen={(id) => void openTask(id)} onNew={() => setNewQuest(true)} />
                  <ErrorNote error={state.error} onDismiss={() => dispatch({ type: "patch", patch: { error: null } })} />
                </>
              )}
            </div>
          )}

          {tab === "chat" && (
            <ChatPanel
              state={state}
              project={project}
              connected={state.chatgpt.connected}
              claudeReady={claudeReady}
              query={chatQuery}
              onQuery={setChatQuery}
              onSend={(t) => void sendChat(t)}
              onStop={() => {
                void api.chatCancel();
                void api.researchCancel();
              }}
              onNew={() => void newConv()}
              onOpenConv={(id) => void openConv(id)}
              onRename={(id, t) => void renameConv(id, t)}
              onDelete={(id) => void deleteConv(id)}
              onResearch={() => void startResearch()}
              onCancelResearch={() => void api.researchCancel()}
            />
          )}

          {tab === "library" && (
            <LibraryReader
              project={project}
              docs={libDocs}
              hover={hoveredDoc}
              doc={libDoc}
              loading={libLoading}
              error={libError}
              connected={state.chatgpt.connected}
              currentConversationTitle={state.conversation && state.chatMessages.length > 0 ? state.conversation.title : null}
              onBack={() => {
                setLibDoc(null);
                libRef.current?.setSelectedIndex(-1);
              }}
              onRefreshDoc={() => libDoc && void openDoc(libDoc.path)}
              onRefreshShelves={() => void loadShelves()}
              onAsk={(cur) => void askAboutDoc(cur)}
            />
          )}
        </section>
      </main>

      {permission && <PermissionDialog request={permission} onDecide={(allow) => void api.permissionDecide(permission.requestId, allow).catch(fail)} />}
    </div>
  );
}
