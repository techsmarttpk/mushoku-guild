// Typed wrappers around the Rust commands. The frontend only ever talks to Rust through these.
import { Channel, invoke } from "@tauri-apps/api/core";

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
}

export interface BenchTick {
  seq: number;
  sentAtMs: number;
  text: string;
}

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
