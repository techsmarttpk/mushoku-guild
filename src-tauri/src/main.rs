// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--mcp-approver") {
        mushoku_guild_lib::run_approver();
        return;
    }
    mushoku_guild_lib::run()
}
