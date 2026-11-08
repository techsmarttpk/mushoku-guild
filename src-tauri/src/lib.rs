mod bench;

use serde::Serialize;

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
