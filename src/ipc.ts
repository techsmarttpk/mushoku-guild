// Typed wrappers around the Rust commands. The frontend only ever talks to Rust through these.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
}

export interface BenchConfig {
  enabled: boolean;
  scenario: string;
  blurStops: boolean;
  marksMs: number[];
}

export interface BenchTick {
  seq: number;
  sentAtMs: number;
  text: string;
}

/** Rust-published window state: WebView2 itself does not report minimisation to the page. */
export const onWindowMinimized = (handler: (minimized: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>("window-minimized", (e) => handler(e.payload));

export const appInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");
export const benchConfig = (): Promise<BenchConfig> => invoke<BenchConfig>("bench_config");
export const benchReady = (): Promise<void> => invoke("bench_ready");
export const benchReport = (report: unknown): Promise<void> => invoke("bench_report", { report });

/** Starts the Phase 2 measurement stream; `onTick` receives ordered ticks from the Rust core. */
export function benchStream(
  onTick: (tick: BenchTick) => void,
  rateHz: number,
  durationMs: number,
): Promise<void> {
  const channel = new Channel<BenchTick>();
  channel.onmessage = onTick;
  return invoke("bench_stream", { onTick: channel, rateHz, durationMs });
}
