import { useEffect, useRef, useState } from "react";
import { LatencyStats, nowUnixMs, type LatencySummary } from "./bench";
import { CafeScene, type SceneDiagnostics, type SceneMode } from "./cafe/CafeScene";
import { appInfo, benchConfig, benchReady, benchReport, benchStream, type AppInfo } from "./ipc";

interface LifecycleEvent {
  atMs: number;
  kind: string;
  hidden: boolean;
  focused: boolean;
}

const ACTIVE_RATE_HZ = 60;
const ACTIVE_DURATION_MS = 45_000;
const DEMO_DURATION_MS = 10_000;

const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "n/a");

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CafeScene | null>(null);
  const baseMode = useRef<SceneMode>("ambient");
  const blurStops = useRef(false);
  const benchEnabled = useRef(false);
  const scenario = useRef("none");
  const lifecycle = useRef<LifecycleEvent[]>([]);
  const lastSummary = useRef<LatencySummary | null>(null);

  const [info, setInfo] = useState<AppInfo | null>(null);
  const [diag, setDiag] = useState<SceneDiagnostics | null>(null);
  const [status, setStatus] = useState("starting");
  const [summary, setSummary] = useState<LatencySummary | null>(null);
  const [running, setRunning] = useState(false);

  function buildReport(): unknown {
    let diagnostics: SceneDiagnostics | null = null;
    try {
      diagnostics = sceneRef.current?.diagnostics() ?? null;
    } catch {
      diagnostics = null; // scene already disposed
    }
    return { scenario: scenario.current, diagnostics, lifecycle: lifecycle.current, stream: lastSummary.current };
  }

  /** Runs the Phase 2 measurement stream and shows coalesced (2 Hz) statistics, never per-tick UI updates. */
  async function runStream(rateHz: number, durationMs: number): Promise<void> {
    setRunning(true);
    setSummary(null);
    const stats = new LatencyStats();
    await benchStream((t) => stats.add(nowUnixMs() - t.sentAtMs, t.seq), rateHz, durationMs);
    const timer = setInterval(() => setSummary(stats.summary()), 500);
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs + 1000));
    clearInterval(timer);
    lastSummary.current = stats.summary();
    setSummary(lastSummary.current);
    setRunning(false);
    if (benchEnabled.current) {
      await benchReport(buildReport());
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new CafeScene();
    sceneRef.current = scene;
    let cancelled = false;

    const syncMode = (): void => {
      const stop = document.hidden || (blurStops.current && !document.hasFocus());
      scene.setMode(stop ? "stopped" : baseMode.current);
    };
    const record = (kind: string): void => {
      lifecycle.current.push({ atMs: nowUnixMs(), kind, hidden: document.hidden, focused: document.hasFocus() });
      syncMode();
      if (benchEnabled.current) {
        void benchReport(buildReport()).catch((e: unknown) => setStatus(`report failed: ${String(e)}`));
      }
    };
    const onVisibility = (): void => record("visibilitychange");
    const onFocus = (): void => record("focus");
    const onBlur = (): void => record("blur");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    void (async () => {
      try {
        const [cfg, ai] = await Promise.all([benchConfig(), appInfo()]);
        if (cancelled) return;
        benchEnabled.current = cfg.enabled;
        blurStops.current = cfg.blurStops;
        scenario.current = cfg.scenario;
        baseMode.current = cfg.scenario === "active" ? "active" : "ambient";
        setInfo(ai);
        await scene.init(host);
        if (cancelled) return;
        syncMode();
        setDiag(scene.diagnostics());
        await benchReady();
        setStatus("ready");
        if (cfg.scenario === "active") {
          await runStream(ACTIVE_RATE_HZ, ACTIVE_DURATION_MS);
        }
      } catch (e) {
        setStatus(`error: ${String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  return (
    <main>
      <h1>Mushoku Guild — Phase 2 walking skeleton</h1>
      <div ref={hostRef} className="scene-host" />
      <div className="panel">
        {`status: ${status}\n`}
        {info ? `app: ${info.name} ${info.version} | tauri ${info.tauriVersion} | ${info.os}/${info.arch}\n` : ""}
        {diag ? `renderer: ${diag.renderer} | gpu: ${diag.gpuRenderer}\n` : ""}
        {summary
          ? `stream: n=${summary.count} p50=${fmt(summary.p50Ms)} ms p95=${fmt(summary.p95Ms)} ms max=${fmt(summary.maxMs)} ms gaps=${summary.gaps}`
          : "stream: not run"}
      </div>
      <div>
        <button disabled={running} onClick={() => void runStream(ACTIVE_RATE_HZ, DEMO_DURATION_MS).catch((e: unknown) => setStatus(`stream failed: ${String(e)}`))}>
          Run 10 s event-stream demo
        </button>
      </div>
    </main>
  );
}
