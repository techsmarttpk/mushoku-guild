mod approver;
mod attachments;
mod uchat;
mod autopilot;
mod browser;
mod chat;
mod library;
mod repo;
mod services;
mod chatgpt;
mod claude;
mod commands;
mod db;
mod events;
mod project_context;
mod fsops;
mod git;
mod repo_cmds;
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
    let identity = repo::identity_of(std::path::Path::new(&dir));
    let Ok(project) = db.add_project_with_identity(&dir, "dev-seed-project", &identity) else { return };
    let _ = db.save_repo_prefs(project.id, true, "ask_each", false, &identity, &dir);
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
            let state = commands::AppState::new(db, dir);
            let db = state.db.clone();
            {
                // files whose quest or record is gone (crash between write and record, deleted quest) are removed
                let (db, root) = (state.db.clone(), attachments::root(&state.data_dir));
                std::thread::spawn(move || {
                    attachments::sweep_orphans(&root, &db.attachment_paths());
                });
            }
            std::thread::spawn(move || {
                // projects created before identities existed get one (Git root commit, else normalised path)
                for p in db.projects().into_iter().filter(|p| p.identity.is_empty()) {
                    if std::path::Path::new(&p.path).is_dir() {
                        db.set_identity(p.id, &repo::identity_of(std::path::Path::new(&p.path)));
                    }
                }
            });
            repo_cmds::start_hub(app.handle().clone(), state.hub.clone());
            app.manage(state);
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
            commands::project_context,
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
            commands::run_set_autopilot,
            commands::research_get,
            commands::research_start,
            commands::research_cancel,
            commands::chat_open,
            commands::chat_new,
            commands::chat_send,
            commands::chat_cancel,
            commands::chat_list,
            commands::chat_open_conv,
            commands::chat_rename,
            commands::chat_delete,
            commands::library_list,
            commands::library_read,
            commands::library_ask,
            commands::repo_prefs_get,
            commands::repo_prefs_save,
            commands::repo_prefs_revoke,
            commands::project_relink,
            commands::quest_history,
            commands::browser_status,
            commands::browser_install_extension,
            commands::browser_open_chrome,
            commands::services_get,
            commands::service_open,
            commands::service_stop,
            commands::service_focus,
            repo_cmds::git_watch,
            repo_cmds::git_state,
            repo_cmds::git_branches,
            repo_cmds::git_graph,
            repo_cmds::git_commit_detail,
            repo_cmds::git_diff,
            repo_cmds::git_remotes,
            repo_cmds::git_tags,
            repo_cmds::git_stashes,
            repo_cmds::git_conflict,
            repo_cmds::git_push_preview,
            repo_cmds::git_sync_sentence,
            repo_cmds::git_op,
            repo_cmds::git_cancel,
            repo_cmds::fs_list,
            repo_cmds::fs_read,
            repo_cmds::fs_write,
            repo_cmds::fs_create,
            repo_cmds::fs_rename,
            repo_cmds::fs_delete,
            repo_cmds::fs_stat,
            repo_cmds::workspace_get,
            repo_cmds::workspace_save,
            repo_cmds::cmd_run,
            repo_cmds::cmd_cancel,
            commands::attachment_add,
            commands::attachment_list,
            commands::attachment_remove,
            commands::attachment_preview,
            uchat::uchat_list,
            uchat::uchat_open,
            uchat::uchat_older,
            uchat::uchat_send,
            uchat::uchat_cancel,
            uchat::uchat_rename,
            uchat::uchat_delete,
            commands::permission_decide
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mushoku Guild");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<commands::AppState>() {
                state.runner.shutdown(); // nothing may outlive the app
                state.services.stop_all();
                state.cmds.stop_all();
            }
        }
    });
}
