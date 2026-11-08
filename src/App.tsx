import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CafeScene, SCENE_H, SCENE_W } from "./cafe/CafeScene.ts";
import { projectScene } from "./domain/scene.ts";
import { initialState, reduce } from "./domain/store.ts";
import type { Model, Policy, Project, ProviderError, Task } from "./domain/types.ts";
import { api, onAppEvent, onWindowMinimized, toProviderError } from "./ipc.ts";
import { ActivityFeed, ErrorNote, GuildPanel, HistoryList, NewTask, PermissionDialog, TaskView } from "./ui/panels.tsx";

type Tab = "quest" | "guild" | "log";

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [tab, setTab] = useState<Tab>("guild");
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [authError, setAuthError] = useState<ProviderError | null>(null);
  const [policy, setPolicy] = useState<Policy>("ask_each");
  const [scale, setScale] = useState(2);
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CafeScene | null>(null);
  const minimized = useRef(false);

  const project = useMemo(() => state.projects.find((p) => p.id === state.currentProjectId) ?? null, [state.projects, state.currentProjectId]);
  const permission = state.permissions[0] ?? null;
  const status = state.detail?.task.status ?? null;

  const fail = useCallback((e: unknown) => dispatch({ type: "patch", patch: { error: toProviderError(e) } }), []);

  // ---- boot: snapshot, Claude detection, event stream
  const loadTasks = useCallback(async (projectId: number | null) => {
    dispatch({ type: "patch", patch: { tasks: projectId === null ? [] : await api.taskList(projectId) } });
  }, []);

  const openTask = useCallback(
    async (id: number) => {
      try {
        dispatch({ type: "select_task", detail: await api.taskGet(id) });
        setTab("quest");
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );

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
        dispatch({
          type: "patch",
          patch: { projects: snap.projects, settings: snap.settings, dbNote: snap.dbNote, chatgpt: snap.chatgpt, currentProjectId },
        });
        const saved = snap.settings["policy"];
        if (saved === "read_only" || saved === "ask_each" || saved === "accept_edits") setPolicy(saved);
        await loadTasks(currentProjectId);
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
  }, [fail, loadTasks]);

  // ---- café scene: created once, driven only by projected real state
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
    () => projectScene({ status, streaming: state.streaming, permissionPending: state.permissions.length > 0, currentTool: state.currentTool }),
    [status, state.streaming, state.permissions.length, state.currentTool],
  );
  useEffect(() => {
    sceneRef.current?.setState(sceneState);
  }, [sceneState]);

  // ---- integer-ish scaling of the pixel canvas to the available width
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const k = Math.max(1, Math.floor((w / SCENE_W) * 4) / 4);
      setScale(Math.min(k, 3.5));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  // ---- actions
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

  const generate = useCallback(
    async (taskId: number, note: string | null) => {
      try {
        const g = await api.reasonerGenerate(taskId, note);
        dispatch({ type: "generation_started", generation: g });
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
      await loadTasks(project.id);
      dispatch({ type: "select_task", detail: await api.taskGet(t.id) });
      if (state.chatgpt.connected) await generate(t.id, null);
    });

  const approve = (body: string) =>
    run("approve", async () => {
      const d = state.detail;
      if (!d) return;
      let draft = d.drafts.at(-1);
      if (!draft) return;
      if (body.trim() !== draft.body.trim()) draft = await api.promptSave(d.task.id, body);
      await api.promptApprove(d.task.id, draft.id);
      dispatch({ type: "select_task", detail: await api.taskGet(d.task.id) });
    });

  const retry = () =>
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
      await api.runStart(d.task.id, policy);
    });

  // refresh the stored detail once a run or generation finishes (adds drafts/executions to the view)
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const id = state.selectedTaskId;
    if (id === null || status === null) return;
    const prev = lastStatus.current;
    lastStatus.current = status;
    if (prev === null || prev === status) return;
    if (["completed", "failed", "cancelled", "prompt_ready", "accepted"].includes(status)) {
      void api.taskGet(id).then(
        (detail) => dispatch({ type: "patch", patch: { detail } }),
        () => undefined,
      );
      if (state.currentProjectId !== null) void loadTasks(state.currentProjectId);
    }
  }, [status, state.selectedTaskId, state.currentProjectId, loadTasks]);

  const pickProject = () =>
    run("project", async () => {
      const p = await api.projectPick();
      if (!p) return;
      const snap = await api.snapshot();
      dispatch({ type: "patch", patch: { projects: snap.projects, currentProjectId: p.id, selectedTaskId: null, detail: null, activity: [] } });
      await loadTasks(p.id);
    });

  const selectProject = (p: Project) =>
    run("project", async () => {
      await api.projectSelect(p.id);
      dispatch({ type: "patch", patch: { currentProjectId: p.id, selectedTaskId: null, detail: null, activity: [] } });
      await loadTasks(p.id);
    });

  const setSetting = (key: string, value: string) =>
    run("setting", async () => {
      await api.settingsSet(key, value);
      dispatch({ type: "patch", patch: { settings: { ...state.settings, [key]: value } } });
    });

  const claudeReady = !!state.claude?.path && !state.claude.error;
  const openTaskFromList = (t: Task) => void openTask(t.id);

  return (
    <div className="app">
      <header className="top">
        <h1>Mushoku Guild</h1>
        <nav className="tabs" role="tablist">
          {(["quest", "guild", "log"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {t === "quest" ? "Quest" : t === "guild" ? "Guild" : "Log"}
              {t === "guild" && (!state.chatgpt.connected || !claudeReady) && <span className="dot" title="Setup needed" />}
            </button>
          ))}
        </nav>
        <div className="chips">
          <span className={`chip ${state.chatgpt.connected ? "ok" : ""}`}>ChatGPT {state.chatgpt.connected ? "●" : "○"}</span>
          <span className={`chip ${claudeReady ? "ok" : ""}`}>Claude {claudeReady ? "●" : "○"}</span>
          <span className="chip">{project ? project.name : "no project"}</span>
        </div>
      </header>

      <main className="cols">
        <section className="left">
          <div className="cafe-slot" ref={wrapRef}>
            <div className="cafe" style={{ "--w": `${Math.round(SCENE_W * scale)}px`, "--h": `${Math.round(SCENE_H * scale)}px` } as React.CSSProperties}>
              <div ref={hostRef} className="cafe-canvas" />
            </div>
          </div>
          <div className="activity panel">
            <h2 className="panel-title">Activity {status && <small>· {state.detail?.task.title}</small>}</h2>
            <ActivityFeed items={state.activity} empty="Nothing has happened yet. When Claude Code works, every message, tool call and permission request appears here." />
          </div>
        </section>

        <section className="right panel">
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
              onPickProject={() => void pickProject()}
              onSelectProject={(p) => void selectProject(p)}
            />
          )}

          {tab === "quest" && (
            <div className="stack">
              {!state.detail ? (
                <>
                  <NewTask project={project} connected={state.chatgpt.connected} onSubmit={(t, d) => void submitTask(t, d)} busy={busy === "task"} />
                  <ErrorNote error={state.error} onDismiss={() => dispatch({ type: "patch", patch: { error: null } })} />
                </>
              ) : (
                <>
                  <button className="link" onClick={() => dispatch({ type: "patch", patch: { selectedTaskId: null, detail: null, activity: [], error: null } })}>
                    ← New quest
                  </button>
                  <TaskView
                    state={state}
                    detail={state.detail}
                    connected={state.chatgpt.connected}
                    claudeReady={claudeReady}
                    policy={policy}
                    onPolicy={setPolicy}
                    onGenerate={(note) => void generate(state.detail?.task.id ?? 0, note)}
                    onStopReasoner={() => void api.reasonerCancel()}
                    onApprove={(b) => void approve(b)}
                    onStart={() => void startRun()}
                    onCancelRun={() => void api.runCancel()}
                    onAccept={() => void run("accept", async () => {
                      if (state.detail) await api.taskAccept(state.detail.task.id);
                    })}
                    onRetry={() => void retry()}
                  />
                </>
              )}
            </div>
          )}

          {tab === "log" && (
            <div className="stack">
              <h3>Quests in {project?.name ?? "—"}</h3>
              <HistoryList tasks={state.tasks} selectedId={state.selectedTaskId} onOpen={openTaskFromList} />
            </div>
          )}
        </section>
      </main>

      {permission && (
        <PermissionDialog
          request={permission}
          onDecide={(allow) => void api.permissionDecide(permission.requestId, allow).catch(fail)}
        />
      )}
    </div>
  );
}
