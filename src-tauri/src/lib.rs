mod bench;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{Emitter, WindowEvent};

/// WebView2 does not tell the page when its host window is minimised (observed in Phase 2 task 2.4),
/// so the Rust core owns window state and publishes changes; the scene stops rendering while minimised.
static MINIMIZED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    tauri_version: &'static str,
    os: &'static str,
    arch: &'static str,
}

/// The walking skeleton's single product-side command: proves a typed Rust -> React call.
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        tauri_version: tauri::VERSION,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

pub fn run() {
    bench::mark_started();
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                let now = window.is_minimized().unwrap_or(false);
                if MINIMIZED.swap(now, Ordering::Relaxed) != now {
                    let _ = window.emit("window-minimized", now);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            bench::bench_config,
            bench::bench_ready,
            bench::bench_report,
            bench::bench_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mushoku Guild");
}
