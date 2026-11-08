//! Phase 2 MEASUREMENT FIXTURES ONLY. This is not product functionality and it is not agent activity.
//!
//! The commands here let the measurement harness (`tools/measure`) drive and observe the app:
//! report startup, run a synthetic event stream to measure core -> UI latency, and write a small
//! report. They are inert unless the harness sets `MUSHOKU_BENCH_OUT`; the output location comes
//! only from that environment variable, never from the frontend. Remove or gate behind a Cargo
//! feature before Phase 3 (tracked in docs/plan.md).

use std::{
    fs,
    path::PathBuf,
    sync::OnceLock,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::ipc::Channel;

static STARTED: OnceLock<Instant> = OnceLock::new();

pub fn mark_started() {
    let _ = STARTED.set(Instant::now());
}

fn out_base() -> Option<PathBuf> {
    std::env::var_os("MUSHOKU_BENCH_OUT").map(PathBuf::from)
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchConfig {
    enabled: bool,
    /// "none" (normal run), "idle" or "active".
    scenario: String,
    /// When true the scene stops rendering on window blur (experiment switch for task 2.4).
    blur_stops: bool,
}

#[tauri::command]
pub fn bench_config() -> BenchConfig {
    let scenario = std::env::var("MUSHOKU_BENCH_SCENARIO").unwrap_or_else(|_| "none".into());
    BenchConfig {
        enabled: out_base().is_some(),
        scenario,
        blur_stops: std::env::var("MUSHOKU_BENCH_BLUR_STOPS").map(|v| v == "1").unwrap_or(false),
    }
}

/// Called by the frontend after the first scene frame is rendered.
#[tauri::command]
pub fn bench_ready() -> Result<(), String> {
    let Some(base) = out_base() else { return Ok(()) };
    let since_main_ms = STARTED.get().map(|s| s.elapsed().as_secs_f64() * 1000.0).unwrap_or(-1.0);
    let body = serde_json::json!({ "sinceMainMs": since_main_ms, "unixMs": now_ms() });
    fs::write(base.with_extension("ready.json"), body.to_string()).map_err(|e| e.to_string())
}

/// Called by the frontend with a JSON report (lifecycle events, latency statistics).
#[tauri::command]
pub fn bench_report(report: serde_json::Value) -> Result<(), String> {
    let Some(base) = out_base() else { return Ok(()) };
    fs::write(base.with_extension("report.json"), report.to_string()).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchTick {
    seq: u64,
    /// Unix time in milliseconds when the core sent the tick; the frontend subtracts it from its own clock.
    sent_at_ms: f64,
    /// Short text so the payload is the size of a small token delta.
    text: String,
}

/// Streams `rate_hz` synthetic ticks per second for `duration_ms` over an ordered Tauri Channel.
#[tauri::command]
pub fn bench_stream(on_tick: Channel<BenchTick>, rate_hz: u32, duration_ms: u64) -> Result<(), String> {
    if !(1..=240).contains(&rate_hz) || duration_ms == 0 || duration_ms > 600_000 {
        return Err("rate_hz must be 1..=240 and duration_ms 1..=600000".into());
    }
    thread::spawn(move || {
        let period = Duration::from_secs_f64(1.0 / f64::from(rate_hz));
        let start = Instant::now();
        let end = Duration::from_millis(duration_ms);
        let mut next = start;
        let mut seq = 0u64;
        while start.elapsed() < end {
            let tick = BenchTick { seq, sent_at_ms: now_ms(), text: format!("tok{seq:08}") };
            if on_tick.send(tick).is_err() {
                break; // the frontend went away
            }
            seq += 1;
            next += period;
            if let Some(wait) = next.checked_duration_since(Instant::now()) {
                thread::sleep(wait);
            }
        }
    });
    Ok(())
}
