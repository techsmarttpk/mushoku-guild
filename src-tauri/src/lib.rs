mod approver;
mod chatgpt;
mod claude;
mod commands;
mod db;
mod events;
mod secrets;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager, WindowEvent};

/// WebView2 does not tell the page when its host window is minimised (observed in Phase 2 task 2.4),
/// so the Rust core owns window state and publishes changes; the scene stops rendering while minimised.
static MINIMIZED: AtomicBool = AtomicBool::new(false);

/// Only with `--features dev-seed` (never in the shipped installer): lets verification create a project, a task and an approved
/// prompt without the ChatGPT sign-in, so the Claude Code path can be exercised on a disposable folder.
/// This is a test fixture, not a provider mock: Claude Code itself is always the real CLI.
#[cfg(feature = "dev-seed")]
fn dev_seed(db: &db::Db) {
    let (Ok(dir), Ok(prompt)) = (std::env::var("MUSHOKU_DEV_SEED_PROJECT"), std::env::var("MUSHOKU_DEV_SEED_PROMPT")) else { return };
    let Ok(project) = db.add_project(&dir, "dev-seed-project") else { return };
    let Ok(task) = db.create_task(project.id, "Seeded test quest", &prompt) else { return };
    for st in ["reasoning", "prompt_ready", "approved"] {
        let _ = db.set_status(task.id, st);
    }
    if let Ok(d) = db.add_draft(task.id, &prompt, "user", None) {
        let _ = db.approve_draft(d.id);
    }
    let _ = db.set_setting("current_project_id", &project.id.to_string());
}

/// Entry point for `mushoku-guild.exe --mcp-approver` (Claude Code starts it; see `approver.rs`).
pub fn run_approver() {
    approver::run();
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = commands::data_dir(app.handle());
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::open(&dir.join("mushoku.db")).map_err(|m| -> Box<dyn std::error::Error> { m.into() })?;
            db.recover_interrupted();
            #[cfg(feature = "dev-seed")]
            dev_seed(&db);
            app.manage(commands::AppState::new(db, dir));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                let now = window.is_minimized().unwrap_or(false);
                if MINIMIZED.swap(now, Ordering::Relaxed) != now {
                    let _ = window.emit("window-minimized", now);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::settings_set,
            commands::project_pick,
            commands::project_select,
            commands::task_list,
            commands::task_create,
            commands::task_get,
            commands::task_accept,
            commands::chatgpt_status,
            commands::chatgpt_connect,
            commands::chatgpt_cancel_connect,
            commands::chatgpt_disconnect,
            commands::chatgpt_models,
            commands::reasoner_generate,
            commands::reasoner_cancel,
            commands::prompt_save,
            commands::prompt_approve,
            commands::claude_detect,
            commands::claude_pick_exe,
            commands::run_start,
            commands::run_cancel,
            commands::permission_decide
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mushoku Guild");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<commands::AppState>() {
                state.runner.shutdown(); // nothing may outlive the app
            }
        }
    });
}
