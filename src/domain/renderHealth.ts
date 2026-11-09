// Renderer health: a tiny pure state machine for the café canvas, so recovery decisions are testable without WebGL.
// A lost context is normally restored by the browser; if it is not (or drawing keeps throwing) the scene is rebuilt a
// couple of times automatically (never the whole application), and after that the user gets a Retry button.

export type RenderState = "ok" | "lost" | "failed";

export interface RenderHealth {
  state: RenderState;
  /** consecutive failed draws */
  drawFailures: number;
  /** why the renderer is not ok (shown in the fallback and logged) */
  reason: string | null;
}

export const HEALTHY: RenderHealth = { state: "ok", drawFailures: 0, reason: null };
/** Consecutive draw exceptions tolerated before the scene is declared failed. */
export const MAX_DRAW_FAILURES = 3;
/** How long a lost WebGL context may stay lost before it counts as failed. */
export const RESTORE_WAIT_MS = 2500;
/** Automatic rebuilds allowed inside the window before the user has to press Retry. */
export const MAX_AUTO_REBUILDS = 2;
export const AUTO_REBUILD_WINDOW_MS = 60_000;

export type HealthEvent = { type: "context_lost" } | { type: "context_restored" } | { type: "restore_timeout" } | { type: "draw_ok" } | { type: "draw_error"; message: string } | { type: "init_error"; message: string } | { type: "rebuilt" };

export function nextHealth(h: RenderHealth, e: HealthEvent): RenderHealth {
  switch (e.type) {
    case "context_lost":
      return h.state !== "ok" ? h : { ...h, state: "lost", reason: "The graphics context was lost." };
    case "context_restored":
      return h.state === "lost" ? { state: "ok", drawFailures: 0, reason: null } : h;
    case "restore_timeout":
      return h.state === "lost" ? { ...h, state: "failed", reason: "The graphics context was lost and did not come back." } : h;
    case "draw_ok":
      return h.drawFailures === 0 || h.state !== "ok" ? h : { ...h, drawFailures: 0 };
    case "draw_error": {
      const n = h.drawFailures + 1;
      return n >= MAX_DRAW_FAILURES ? { state: "failed", drawFailures: n, reason: `Drawing failed ${n} times: ${e.message}` } : { ...h, drawFailures: n };
    }
    case "init_error":
      return { state: "failed", drawFailures: 0, reason: `The café could not start: ${e.message}` };
    case "rebuilt":
      return HEALTHY;
  }
}

/** Whether a failed renderer should be rebuilt automatically now, given the times of earlier automatic rebuilds. */
export function shouldAutoRebuild(history: number[], now: number): boolean {
  return history.filter((t) => now - t < AUTO_REBUILD_WINDOW_MS).length < MAX_AUTO_REBUILDS;
}

/** Delay before the n-th automatic rebuild (n starts at 0): short, growing. */
export function rebuildDelay(history: number[], now: number): number {
  return 500 * (1 + history.filter((t) => now - t < AUTO_REBUILD_WINDOW_MS).length);
}
