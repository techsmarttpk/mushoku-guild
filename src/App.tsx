import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CafeScene, SCENE_H, SCENE_W } from "./cafe/CafeScene.ts";
import { LibraryScene } from "./cafe/LibraryScene.ts";
import { msUntilNextDaypart, parseSetting, resolveDaypart, type AtmosphereMode, type Daypart } from "./domain/atmosphere.ts";
import { projectScene } from "./domain/scene.ts";
import { createDirector, toSteps } from "./domain/idle.ts";
import { rebuildDelay, shouldAutoRebuild, type RenderHealth } from "./domain/renderHealth.ts";
import { filterDocs, matchSummary } from "./domain/library.ts";
import { CLOSED, reduceLibSearch } from "./domain/libSearch.ts";
import { fitView, neighbour, type View } from "./domain/shelf.ts";
import { initialState, reduce } from "./domain/store.ts";
import { type DocContent, type LibraryMeta, type Model, type Policy, type Project, type ProviderError, type BrowserStatus, type UProvider } from "./domain/types.ts";
import { createWelcomeGate, pickWelcome } from "./domain/welcome.ts";
import { api, onAppEvent, onWindowMinimized, toProviderError } from "./ipc.ts";
import { ChatPanel } from "./ui/ChatPanel.tsx";
import { AttachmentStrip } from "./ui/Attachments.tsx";
import { UniversalChat } from "./ui/UniversalChat.tsx";
import { Todos, type TodoDraft } from "./ui/Todos.tsx";
import type { Todo } from "./domain/todos.ts";
import { initialU, parseProvider, reduceU } from "./domain/uchat.ts";
import { GuildModels } from "./ui/Openrouter.tsx";
import { ContextBudgetsCard, ContextPicker } from "./ui/ContextPicker.tsx";
import { DEFAULT_MODE, sanitizeMode, type ContextMode } from "./domain/context.ts";
import { STATE_LABEL, canChat, memberState, placeMembers, type GuildMember } from "./domain/guild.ts";
import { readBase64 } from "./domain/attachments.ts";
import { AtmosphereCard, BrowserCard, PermissionsCard, RepoTag, ServicesPanel } from "./ui/Extras.tsx";
import { LibraryReader } from "./ui/Library.tsx";
import { ActivityFeed, ErrorNote, GuildPanel, NewTask, PermissionDialog, TaskView } from "./ui/panels.tsx";
import { QuestHistory } from "./ui/Quests.tsx";
import { ConfirmDialog } from "./ui/repo/common.tsx";
import { RepoWorkspace } from "./ui/repo/RepoWorkspace.tsx";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** One greeting per application launch; React re-renders and effect re-runs cannot repeat it. */
const welcomeGate = createWelcomeGate();

type Tab = "quest" | "todo" | "chat" | "uchat" | "library" | "repo" | "guild";
const TAB_LABEL: Record<Tab, string> = { quest: "Quests", todo: "To-Do", chat: "Guild Chat", uchat: "Universal Chat", library: "Library", repo: "Repo", guild: "Guild" };

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [u, uDispatch] = useReducer(reduceU, initialU);
  const [guild, setGuild] = useState<GuildMember[]>([]);
  const [ctxQuest, setCtxQuest] = useState<ContextMode>(DEFAULT_MODE.quest);
  const [ctxChat, setCtxChat] = useState<ContextMode>(DEFAULT_MODE.chat);
  /** Universal Chat always starts with nothing shared; the choice is never restored */
  const [ctxU, setCtxU] = useState<ContextMode>("none");
  const [ctxUProject, setCtxUProject] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ id: number; x: number; y: number; headY: number } | null>(null);
  const [removeAsk, setRemoveAsk] = useState(false);
  const [tab, setTab] = useState<Tab>("guild");
  const [newQuest, setNewQuest] = useState(false);
  // café renderer recovery: a rebuild recreates only the Pixi scene, never the application
  const [sceneEpoch, setSceneEpoch] = useState(0);
  const [sceneDead, setSceneDead] = useState<RenderHealth | null>(null);
  const rebuilds = useRef<number[]>([]);
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
  const [libSearch, libSearchDispatch] = useReducer(reduceLibSearch, CLOSED);
  const libQuery = libSearch.query;
  const libSearchOpen = libSearch.open;
  const setLibQuery = (query: string): void => libSearchDispatch(query === "" ? { type: "clear" } : { type: "type", query });
  const searchRef = useRef<HTMLInputElement>(null);
  const libAreaRef = useRef<HTMLDivElement>(null);
  const [libFit, setLibFit] = useState<{ scale: number; view: View }>(() => fitView(576, 352));
  const libFitRef = useRef(libFit);
  libFitRef.current = libFit;
  const [libLost, setLibLost] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const libHostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CafeScene | null>(null);
  const libRef = useRef<LibraryScene | null>(null);
  const minimized = useRef(false);
  const tabRef = useRef<Tab>("guild");
  tabRef.current = tab;
  const syncRef = useRef<() => void>(() => undefined);
  const [dirtyCount, setDirtyCount] = useState(0);
  const dirtyRef = useRef(0);
  dirtyRef.current = dirtyCount;
  const [pendingSwitch, setPendingSwitch] = useState<null | (() => void)>(null);
  const [closeWarn, setCloseWarn] = useState(false);

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
      off = await onAppEvent((event) => {
        dispatch({ type: "event", event });
        uDispatch({ type: "event", event });
      });
      if (cancelled) off();
      try {
        const snap = await api.snapshot();
        const current = Number(snap.settings["current_project_id"] ?? "");
        const currentProjectId = snap.projects.some((p) => p.id === current) ? current : (snap.projects[0]?.id ?? null);
        dispatch({ type: "patch", patch: { projects: snap.projects, settings: snap.settings, dbNote: snap.dbNote, chatgpt: snap.chatgpt, currentProjectId } });
        uDispatch({ type: "provider", provider: parseProvider(snap.settings["uchat_provider"]) });
        void api.guildList().then(setGuild, () => undefined);
        void api.contextPrefs().then(
          (p) => {
            setCtxQuest(sanitizeMode("quest", p.quest));
            setCtxChat(sanitizeMode("chat", p.chat));
          },
          () => undefined,
        );
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

  // closing the window with unsaved editor changes asks first
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested((ev) => {
        if (dirtyRef.current > 0) {
          ev.preventDefault();
          setCloseWarn(true);
        }
      })
      .then((u) => (cancelled ? u() : (off = u)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // ---------------------------------------------------------------- café scene
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new CafeScene();
    sceneRef.current = scene;
    scene.onPick(setPicked);
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    setSceneDead(null);
    scene.onStatus((h) => {
      if (cancelled || h.state !== "failed") return;
      const now = Date.now();
      if (shouldAutoRebuild(rebuilds.current, now)) {
        const wait = rebuildDelay(rebuilds.current, now);
        rebuilds.current.push(now);
        setTimeout(() => !cancelled && setSceneEpoch((e) => e + 1), wait);
      } else setSceneDead(h);
    });
    const sync = (): void => {
      scene.setPaused(document.hidden || minimized.current || tabRef.current === "repo");
      if (!document.hidden && !minimized.current) scene.refresh(); // a hidden or minimised canvas may have been discarded
    };
    syncRef.current = sync;
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    void (async () => {
      await scene.init(host);
      if (cancelled) return;
      sync();
      if (welcomeGate()) scene.welcome(pickWelcome(Math.random));
      unlisten = await onWindowMinimized((m) => {
        minimized.current = m;
        sync(); // restoring from minimise redraws
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      scene.destroy();
      sceneRef.current = null;
    };
  }, [sceneEpoch]);
  useEffect(() => {
    syncRef.current(); // also redraws: the café canvas is hidden while the Library tab is open
  }, [tab]);
  // Recruited models stand in the café. The scene keeps the list across its own rebuilds (sceneEpoch).
  useEffect(() => {
    sceneRef.current?.setGuild(guild.map((m) => ({ id: m.id, seed: m.seed, name: m.name, vendor: m.vendor, state: memberState(m) })));
  }, [guild, sceneEpoch]);
  useEffect(() => {
    sceneRef.current?.select(picked?.id ?? null);
    setRemoveAsk(false);
    if (!picked) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPicked(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, sceneEpoch]);
  useEffect(() => {
    sceneRef.current?.refresh();
  }, [scale]);

  // ---------------------------------------------------------------- idle conversations (local, offline: no AI call is ever made)
  const director = useMemo(() => createDirector(Math.random), []);
  const outcome = useRef<{ kind: "success" | "failure"; at: number } | null>(null);
  const idleFacts = useRef({ pending: 0, blocked: false });
  idleFacts.current = {
    pending: state.quests.filter((q) => ["draft", "prompt_ready", "approved"].includes(q.status)).length,
    // an open permission request or a focused text field means the owner is busy: stay quiet
    blocked: state.permissions.length > 0,
  };
  const lastStatusSeen = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastStatusSeen.current;
    lastStatusSeen.current = status;
    if (prev === "running" && (status === "completed" || status === "failed")) outcome.current = { kind: status === "completed" ? "success" : "failure", at: Date.now() };
  }, [status]);
  const [idleKick, setIdleKick] = useState(0);
  useEffect(() => {
    // a finished quest is commented on soon after the café settles; otherwise the normal relaxed rhythm applies
    const wait = outcome.current && Date.now() - outcome.current.at < 10 * 60_000 ? 9000 : director.delay();
    const t = setTimeout(() => {
      const scene = sceneRef.current;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
      const fact = idleFacts.current;
      const o = outcome.current && Date.now() - outcome.current.at < 10 * 60_000 ? outcome.current.kind : null;
      if (scene && !document.hidden && !typing && !fact.blocked && scene.canChat()) {
        const e = director.next({ daypart: scene.currentTheme(), outcome: o, pending: fact.pending }, Date.now());
        if (e) {
          scene.welcome(toSteps(e));
          if (o) outcome.current = null; // reacted once
        }
      }
      setIdleKick((n) => n + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [idleKick, director]);

  // ---------------------------------------------------------------- café atmosphere (local clock, never UTC)
  const atmoSetting = useMemo(() => parseSetting(state.settings), [state.settings]);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (atmoSetting.mode !== "auto") return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => {
        setClock(new Date());
        arm();
      }, msUntilNextDaypart(new Date()) + 500);
    };
    // timers can be late after sleep or a throttled background window: re-read the clock whenever the app is looked at again
    const refresh = (): void => {
      if (!document.hidden) setClock(new Date());
    };
    setClock(new Date());
    arm();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [atmoSetting.mode]);
  const daypart: Daypart = resolveDaypart(atmoSetting, clock);
  const settingsReady = Object.keys(state.settings).length > 0 || state.projects.length > 0 || state.chatgpt.connected;
  useEffect(() => {
    if (settingsReady || atmoSetting.mode === "auto") sceneRef.current?.setTheme(daypart);
  }, [daypart, settingsReady, atmoSetting.mode, sceneEpoch]);

  const sceneState = useMemo(
    () => projectScene({ status, streaming: state.streaming, permissionPending: state.permissions.length > 0, currentTool: state.currentTool, researching: state.research?.status === "researching" || state.chatResearching !== null, chatting: state.chatStreaming || u.streaming }),
    [status, state.streaming, state.permissions.length, state.currentTool, state.research?.status, state.chatStreaming, state.chatResearching, u.streaming],
  );
  useEffect(() => {
    sceneRef.current?.setState(sceneState);
  }, [sceneState, sceneEpoch]);

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
  // The shelf shows only the matching books; search runs over the already-listed metadata, never over the disk.
  const visibleDocs = useMemo(() => filterDocs(libDocs, libQuery), [libDocs, libQuery]);
  const docsRef = useRef(visibleDocs);
  docsRef.current = visibleDocs;
  // a repository is a workspace: its search text, open book and shelves must not leak into the next one
  useEffect(() => {
    libSearchDispatch({ type: "close" });
    setLibDoc(null);
    setLibDocs([]);
    setLibHover(-1);
    setLibError(null);
  }, [pid]);
  useEffect(() => {
    if (tab !== "library") return;
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLElement && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) {
        e.preventDefault();
        libSearchDispatch({ type: "open" });
        setTimeout(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        }, 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);
  const closeLibSearch = useCallback(() => libSearchDispatch({ type: "close" }), []);
  useEffect(() => {
    if (tab !== "library") closeLibSearch(); // leaving the Library closes the search interface
  }, [tab, closeLibSearch]);
  // The shelf follows the size of the space it is given; only the layout is recomputed, the scene is kept.
  useEffect(() => {
    const el = libAreaRef.current;
    if (tab !== "library" || !el) return;
    const measure = (): void => {
      const fit = fitView(el.clientWidth, el.clientHeight);
      setLibFit((old) => (old.scale === fit.scale && old.view.w === fit.view.w && old.view.h === fit.view.h ? old : fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);
  useEffect(() => {
    libRef.current?.resize(libFit.view);
  }, [libFit]);
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
      scene.onLost(() => !cancelled && setLibLost((n) => n + 1));
      await scene.init(host, libFitRef.current.view);
      if (!cancelled) scene.setDocs(docsRef.current, null);
    })();
    return () => {
      cancelled = true;
      libRef.current = null;
      scene.destroy();
    };
  }, [tab, openDoc, libLost]);
  useEffect(() => {
    libRef.current?.setDocs(visibleDocs, libDoc?.path ?? null);
    setLibHover(-1);
  }, [visibleDocs, libDoc?.path]);
  const onShelfKey = (e: React.KeyboardEvent): void => {
    const map: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const dir = map[e.key];
    if (dir) {
      e.preventDefault();
      const cur = libDoc ? visibleDocs.findIndex((d) => d.path === libDoc.path) : libHover;
      const next = neighbour(cur, dir, visibleDocs.length, libRef.current?.columns);
      if (next >= 0) {
        libRef.current?.setSelectedIndex(next);
        setLibHover(next);
      }
    } else if (e.key === "Enter" && libHover >= 0) {
      const d = visibleDocs[libHover];
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
        dispatch({ type: "generation_started", generation: await api.reasonerGenerate(taskId, note, ctxQuest) });
        setTab("quest");
      } catch (e) {
        fail(e);
      }
    },
    [fail, ctxQuest],
  );
  const submitTask = (title: string, description: string, files: File[]) =>
    run("task", async () => {
      if (!project) return;
      const t = await api.taskCreate(project.id, title, description);
      const refused: string[] = [];
      for (const f of files) {
        try {
          await api.attachmentAdd(t.id, f.name, await readBase64(f));
        } catch (e) {
          refused.push(toProviderError(e).message);
        }
      }
      if (refused.length) fail({ kind: "other", message: `Some attachments were not added: ${refused.join(" ")}` });
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
      const generation = await api.chatSend(conv.id, text, ctxChat);
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

  // ---------------------------------------------------------------- To-Do (global list; an optional repository tag only labels and filters)
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todoError, setTodoError] = useState<string | null>(null);
  useEffect(() => {
    if (tab === "todo") void api.todoList().then(setTodos, (e: unknown) => setTodoError(toProviderError(e).message));
  }, [tab]);
  const saveTodo = async (d: TodoDraft): Promise<boolean> => {
    setTodoError(null);
    try {
      const saved = await api.todoSave(d.id, d.title, d.description, d.priority, d.due || null, d.projectId);
      setTodos((list) => (list.some((t) => t.id === saved.id) ? list.map((t) => (t.id === saved.id ? saved : t)) : [...list, saved]));
      return true;
    } catch (e) {
      setTodoError(toProviderError(e).message);
      return false;
    }
  };
  const toggleTodo = (id: number, done: boolean): void => {
    void api.todoSetDone(id, done).then((t) => setTodos((list) => list.map((x) => (x.id === id ? t : x))), (e: unknown) => setTodoError(toProviderError(e).message));
  };
  const deleteTodo = (id: number): void => {
    void api.todoDelete(id).then(() => setTodos((list) => list.filter((x) => x.id !== id)), (e: unknown) => setTodoError(toProviderError(e).message));
  };

  // ---------------------------------------------------------------- Universal Chat (global: no repository, own state and storage)
  const reloadU = useCallback(async (query: string) => {
    try {
      uDispatch({ type: "list", convs: await api.uchatList(query) });
    } catch {
      /* the list refreshes again on the next change */
    }
  }, []);
  useEffect(() => {
    if (tab === "uchat") void reloadU(u.query);
  }, [tab, u.query, u.streaming, u.current?.id, reloadU]);
  const uFail = (e: unknown): void => uDispatch({ type: "error", error: toProviderError(e) });
  const uProvider = (p: UProvider, model?: string): void => {
    uDispatch({ type: "provider", provider: p, model });
    if (p === "openrouter") return; // a model is picked per conversation; only the two built-in providers are remembered
    void api.settingsSet("uchat_provider", p).then(() => dispatch({ type: "patch", patch: { settings: { ...state.settings, uchat_provider: p } } }), uFail);
  };
  const uSend = (text: string): void => {
    const model = u.provider === "openrouter" ? (u.current?.model ?? u.model) : null;
    void api.uchatSend(u.current?.id ?? null, u.provider, model, text, ctxU, ctxUProject).then((s) => uDispatch({ type: "sending", conversation: s.conversation, message: s.message, generation: s.generation }), uFail);
  };
  const uOpen = (id: number): void => {
    void api.uchatOpen(id).then((o) => uDispatch({ type: "opened", conversation: o.conversation, messages: o.messages, hasMore: o.hasMore }), uFail);
  };
  const uOlder = (): void => {
    const first = u.messages[0];
    if (!u.current || !first) return;
    void api.uchatOlder(u.current.id, first.id).then(([messages, hasMore]) => uDispatch({ type: "older", messages, hasMore }), uFail);
  };
  const uRename = (id: number, title: string): void => {
    void api.uchatRename(id, title).then(() => {
      uDispatch({ type: "event", event: { type: "u_chat_title", conversationId: id, title } });
      return reloadU(u.query);
    }, uFail);
  };
  const uDelete = (id: number): void => {
    void api.uchatDelete(id).then(() => {
      if (u.current?.id === id) uDispatch({ type: "draft" });
      return reloadU(u.query);
    }, uFail);
  };

  // ---------------------------------------------------------------- projects, settings, browser
  const guard = (fn: () => void): void => (dirtyRef.current > 0 ? setPendingSwitch(() => fn) : fn());
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
  const claudeLines = useMemo(
    () => state.activity.filter((a) => ["tool_use", "tool_result", "tool_error", "permission_auto", "permission_decision", "result", "error", "cancelled", "init"].includes(a.kind)).slice(-300).map((a) => `${a.title}${a.detail ? ` — ${a.detail.split("\n")[0]?.slice(0, 160)}` : ""}`),
    [state.activity],
  );
  const hoveredDoc = libHover >= 0 ? (visibleDocs[libHover] ?? null) : null;
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
            <select className="repo-select" aria-label="Active repository" value={pid ?? ""} onChange={(e) => { const p = state.projects.find((x) => x.id === Number(e.target.value)) ?? null; guard(() => void switchProject(p)); }}>
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

      <main className={`cols ${tab === "repo" ? "repo-mode" : ""}`}>
        <section className="left">
          <div className="cafe-slot" ref={wrapRef} style={{ display: tab === "library" ? "none" : undefined }}>
            <div className="cafe" style={{ "--w": `${Math.round(SCENE_W * scale)}px`, "--h": `${Math.round(SCENE_H * scale)}px` } as React.CSSProperties}>
              <div ref={hostRef} className="cafe-canvas" style={{ display: tab === "library" ? "none" : "block" }} />
              {sceneDead && tab !== "library" && (
                <div className="cafe-fallback" role="alert">
                  <strong>The café lost its picture.</strong>
                  <span>A graphics problem stopped the scene from drawing. Nothing else is affected.</span>
                  <button className="btn btn-primary" onClick={() => { rebuilds.current = []; setSceneEpoch((e) => e + 1); }}>
                    Retry rendering
                  </button>
                  <small className="muted">{sceneDead.reason}</small>
                </div>
              )}
              {tab !== "library" && placeMembers(guild).overflow > 0 && (
                <button className="cafe-more" onClick={() => setTab("guild")} title="The café has no more room: see every member in the Guild tab">
                  +{placeMembers(guild).overflow} more in the Guild
                </button>
              )}
              {picked && tab !== "library" && (() => {
                const m = guild.find((g) => g.id === picked.id);
                if (!m) return null;
                const st = memberState(m);
                const below = picked.headY * scale < 230;
                return (
                  <div
                    className="member-pop"
                    role="dialog"
                    aria-label={`${m.name}, Guild member`}
                    style={{ left: Math.min(Math.max(picked.x * scale, 130), SCENE_W * scale - 130), top: below ? (picked.y + 4) * scale : (picked.headY - 28) * scale, transform: below ? "translate(-50%, 0)" : "translate(-50%, -100%)" }}
                  >
                    <div className="row between">
                      <strong>{m.name}</strong>
                      <button className="link" onClick={() => setPicked(null)} aria-label="Close">
                        ×
                      </button>
                    </div>
                    <div className="small muted">OpenRouter · {m.vendor}</div>
                    <code className="small">{m.modelId}</code>
                    <div className={`or-state or-${st} small`} title={m.reason}>
                      <i aria-hidden /> {STATE_LABEL[st]}
                    </div>
                    {st === "unavailable" && <div className="small">{m.reason}</div>}
                    <div className="row">
                      <button
                        className="btn btn-primary"
                        disabled={!canChat(m)}
                        onClick={() => {
                          uDispatch({ type: "provider", provider: "openrouter", model: m.modelId });
                          setPicked(null);
                          setTab("uchat");
                        }}
                      >
                        Chat
                      </button>
                      <button className="btn" onClick={() => { setPicked(null); setTab("guild"); }}>
                        Details
                      </button>
                      {removeAsk ? (
                        <span className="small">
                          Remove?{" "}
                          <button className="link" onClick={() => { setPicked(null); void api.guildRemove(m.id).then(setGuild, fail); }}>
                            yes
                          </button>{" "}
                          <button className="link" onClick={() => setRemoveAsk(false)}>
                            no
                          </button>
                        </span>
                      ) : (
                        <button className="btn btn-quiet" onClick={() => setRemoveAsk(true)}>
                          Remove
                        </button>
                      )}
                    </div>
                    {removeAsk && <small className="muted">Its conversations are kept.</small>}
                  </div>
                );
              })()}
            </div>
          </div>
          {tab === "library" && (
            <div className="lib-area" ref={libAreaRef}>
              <div
                ref={libHostRef}
                className="library-host"
                style={{ "--w": `${Math.round(libFit.view.w * libFit.scale)}px`, "--h": `${Math.round(libFit.view.h * libFit.scale)}px` } as React.CSSProperties}
                tabIndex={0}
                onKeyDown={onShelfKey}
                aria-label="Bookshelf. Arrow keys move between books, Enter opens one."
              />
              {project && !libSearchOpen && (
                <button className={`lib-search-btn ${libQuery ? "active" : ""}`} onClick={() => { libSearchDispatch({ type: "open" }); setTimeout(() => searchRef.current?.focus(), 0); }} title="Search the library ( / or Ctrl+F )" aria-label="Search the library">
                  <span aria-hidden>🔍</span>
                </button>
              )}
              {project && libSearchOpen && (
                <div className="lib-searchbox" role="search">
                  <input
                    ref={searchRef}
                    type="search"
                    value={libQuery}
                    placeholder="Search books…"
                    aria-label="Search the library"
                    onChange={(e) => setLibQuery(e.target.value)}
                    onBlur={() => libSearchDispatch({ type: "blur" })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        closeLibSearch();
                        libHostRef.current?.focus();
                      }
                    }}
                  />
                  <span className="lib-count" aria-live="polite">{matchSummary(visibleDocs.length, libDocs.length, libQuery)}</span>
                  {libQuery && (
                    <button className="btn btn-quiet" onMouseDown={(e) => e.preventDefault()} onClick={() => { setLibQuery(""); searchRef.current?.focus(); }} aria-label="Clear search">
                      Clear
                    </button>
                  )}
                  <button className="btn btn-quiet" onMouseDown={(e) => e.preventDefault()} onClick={closeLibSearch} aria-label="Close search">
                    ✕
                  </button>
                </div>
              )}
              {libQuery.trim() && visibleDocs.length === 0 && libDocs.length > 0 && (
                <div className="lib-empty" role="status">
                  <span aria-hidden>📚</span> No book on these shelves answers to “{libQuery.trim()}”. The librarian checked every shelf twice. Try a shorter word, or clear the search.
                </div>
              )}
            </div>
          )}
          <div className={`activity panel ${tab === "library" ? "compact" : ""}`}>
            {tab === "chat" ? (
              <>
                <h2 className="panel-title">Research activity {(state.research?.status === "researching" || state.chatResearching !== null) && <small>· Claude is reading the repository</small>}</h2>
                <ActivityFeed items={state.researchActivity} empty="When ChatGPT asks Claude to investigate (or you press Ask Claude for Context), every file Claude reads appears here. Research is read-only." />
              </>
            ) : tab === "todo" ? (
              <>
                <h2 className="panel-title">To-Do <small>· your own list, not quests</small></h2>
                <div className="muted pad">Quick notes for yourself. To-dos are global unless you tag a repository, and they never start Claude or ChatGPT.</div>
              </>
            ) : tab === "uchat" ? (
              <>
                <h2 className="panel-title">Universal Chat <small>· not tied to any repository</small></h2>
                <div className="muted pad">
                  Your own conversations with ChatGPT or Claude. They are global: switching repositories does not change them, and no project is ever shared with them. ChatGPT uses your existing sign-in; Claude uses the installed Claude Code in a no-tools, conversation-only mode.
                </div>
              </>
            ) : tab === "library" ? (
              <>
                <h2 className="panel-title">Shelf <RepoTag project={project} /></h2>
                <div className="muted pad">{hoveredDoc ? `${hoveredDoc.title}  ·  ${hoveredDoc.path}` : libDocs.length ? `${matchSummary(visibleDocs.length, libDocs.length, libQuery)}. Hover for details, click to read.` : "Nothing on the shelves yet."}</div>
              </>
            ) : (
              <>
                <h2 className="panel-title">Activity {status && <small>· {state.detail?.task.title}</small>}</h2>
                <ActivityFeed items={state.activity} empty="Nothing has happened yet. When Claude Code works, every message, tool call and permission request appears here." />
              </>
            )}
          </div>
        </section>

        <section className={`right panel ${tab === "chat" || tab === "uchat" ? "wide" : ""} ${tab === "repo" ? "repo-full" : ""}`}>
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
              onPickProject={() => guard(() => void pickProject())}
              onSelectProject={(p) => guard(() => void switchProject(p))}
              extra={
                <>
                  <GuildModels
                    guild={guild}
                    onGuild={setGuild}
                    onChat={(m) => {
                      uDispatch({ type: "provider", provider: "openrouter", model: m.modelId });
                      setTab("uchat");
                    }}
                  />
                  <ContextBudgetsCard />
                  <AtmosphereCard setting={atmoSetting} current={daypart} onMode={(m: AtmosphereMode) => void setSetting("cafe_mode", m)} onTheme={(d) => void setSetting("cafe_theme", d)} />
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
                  <AttachmentStrip taskId={state.detail.task.id} />
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
                    contextNode={<ContextPicker surface="quest" value={ctxQuest} onChange={setCtxQuest} projectId={pid} query={`${state.detail?.task.title ?? ""}\n${state.detail?.task.description ?? ""}`} disabled={state.detail?.task.status === "reasoning"} />}
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
                  <NewTask project={project} contextNode={(q) => <ContextPicker surface="quest" value={ctxQuest} onChange={setCtxQuest} projectId={pid} query={q} />} connected={state.chatgpt.connected} onSubmit={(t, d, f) => void submitTask(t, d, f)} busy={busy === "task"} />
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
              contextNode={<ContextPicker surface="chat" value={ctxChat} onChange={setCtxChat} projectId={pid} query={state.chatMessages.filter((m) => m.role === "user").at(-1)?.body ?? ""} disabled={state.chatStreaming || state.chatResearching !== null} />}
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

          {tab === "todo" && <Todos todos={todos} projects={state.projects} activeProjectId={pid} busy={false} error={todoError} onSave={saveTodo} onToggle={toggleTodo} onDelete={deleteTodo} />}

          {tab === "uchat" && (
            <UniversalChat
              u={u}
              chatgptConnected={state.chatgpt.connected}
              claudeReady={claudeReady}
              guild={guild}
              contextNode={
                <ContextPicker
                  surface="uchat"
                  value={ctxU}
                  onChange={(m) => {
                    setCtxU(m);
                    if (m !== "none" && ctxUProject === null) setCtxUProject(pid);
                  }}
                  projectId={ctxUProject}
                  projects={state.projects}
                  onProject={setCtxUProject}
                  query={u.messages.filter((m) => m.role === "user").at(-1)?.body ?? ""}
                  disabled={u.streaming}
                  provider={u.provider}
                />
              }
              onProvider={uProvider}
              onQuery={(q) => uDispatch({ type: "query", query: q })}
              onSend={uSend}
              onStop={() => void api.uchatCancel()}
              onNew={() => uDispatch({ type: "draft" })}
              onOpen={uOpen}
              onRename={uRename}
              onDelete={uDelete}
              onOlder={uOlder}
            />
          )}

          {tab === "repo" &&
            (project ? (
              <RepoWorkspace
                key={project.id}
                project={project}
                repo={state.repo}
                output={state.output}
                claudeLines={claudeLines}
                trusted={trusted}
                onRepoState={(rs) => dispatch({ type: "event", event: { type: "repo_state", projectId: project.id, state: rs } })}
                onClearOutput={() => dispatch({ type: "patch", patch: { output: [] } })}
                onDirtyCount={setDirtyCount}
              />
            ) : (
              <div className="note">Connect a project folder in the Guild tab first. The Repo tab works on the active repository.</div>
            ))}

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

      {pendingSwitch && (
        <ConfirmDialog
          title="Unsaved changes in the editor"
          danger
          confirm="Switch and discard the changes"
          message={<p>{dirtyCount} open file{dirtyCount === 1 ? " has" : "s have"} unsaved edits in the Repo tab. Go back and save them first, or discard them.</p>}
          onCancel={() => setPendingSwitch(null)}
          onConfirm={() => {
            const f = pendingSwitch;
            setPendingSwitch(null);
            setDirtyCount(0);
            f();
          }}
        />
      )}
      {closeWarn && (
        <ConfirmDialog
          title="Quit with unsaved changes?"
          danger
          confirm="Discard changes and quit"
          message={<p>{dirtyCount} file{dirtyCount === 1 ? " has" : "s have"} unsaved edits in the Repo tab.</p>}
          onCancel={() => setCloseWarn(false)}
          onConfirm={() => void getCurrentWindow().destroy()}
        />
      )}
      {permission && <PermissionDialog request={permission} onDecide={(allow) => void api.permissionDecide(permission.requestId, allow).catch(fail)} />}
    </div>
  );
}
