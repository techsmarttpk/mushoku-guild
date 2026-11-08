//! Websites and applications launched by a quest. They are a separate lifecycle from the quest execution: the
//! quest is "completed" when Claude finishes, while a dev server it started may keep running (owned by this app
//! through the quest's Job Object) until the user stops it, the quest is re-run or the app closes.
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;

use crate::claude::{kill_tree, Job};
use crate::events::hidden;

fn local_url_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"(?i)https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:/[^\s)\]}>'"`,;]*)?"#).expect("valid"))
}
fn any_url_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"(?i)https?://[a-z0-9][a-z0-9.\-]*(?::\d{2,5})?(?:/[^\s)\]}>'"`,;]*)?"#).expect("valid"))
}

fn clean(u: &str) -> String {
    let u = u.trim_end_matches(['.', ':', '!', '?']).replace("://0.0.0.0", "://localhost");
    u
}

/// Local URLs (localhost, 127.0.0.1, 0.0.0.0, ::1) found in text, deduplicated, in order.
pub fn detect_local_urls(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in local_url_re().find_iter(text) {
        let u = clean(m.as_str());
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

/// Any http(s) URL (used only for the final user-facing result text).
pub fn detect_urls(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in any_url_re().find_iter(text) {
        let u = clean(m.as_str());
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

/// Only plain http(s) URLs without whitespace or control characters may be opened, and only after a user click.
pub fn valid_open_url(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("https://")) && url.len() <= 2000 && !url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '<' | '>' | '^' | '|'))
}

pub fn open_default(url: &str) -> Result<(), String> {
    if !valid_open_url(url) {
        return Err("Only http(s) links can be opened.".into());
    }
    let mut c = Command::new("rundll32");
    c.args(["url.dll,FileProtocolHandler", url]);
    hidden(&mut c).spawn().map(|_| ()).map_err(|e| format!("could not open the browser: {e}"))
}

pub fn open_in_chrome(url: &str) -> Result<(), String> {
    if !valid_open_url(url) {
        return Err("Only http(s) links can be opened.".into());
    }
    let chrome = crate::browser::chrome_path().ok_or("Chrome was not found in its usual locations.")?;
    let mut c = Command::new(chrome);
    c.arg(url);
    hidden(&mut c).spawn().map(|_| ()).map_err(|e| format!("could not start Chrome: {e}"))
}

/// Image name of a process (via `tasklist`), if it still exists.
pub fn process_name(pid: u32) -> Option<String> {
    let mut c = Command::new("tasklist");
    c.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    let (_, out) = crate::claude::capture(c, std::time::Duration::from_secs(8))?;
    let first = out.lines().next()?;
    let name = first.trim().trim_start_matches('"').split('"').next()?.to_string();
    (name.to_ascii_lowercase().ends_with(".exe")).then_some(name)
}

/// Brings the main window of an owned process to the front (best effort).
pub fn focus(pid: u32) -> bool {
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject WScript.Shell).AppActivate([int]$env:MG_PID)"]).env("MG_PID", pid.to_string()).stdin(Stdio::null());
    matches!(crate::claude::capture(c, std::time::Duration::from_secs(8)), Some((0, out)) if out.trim().eq_ignore_ascii_case("true"))
}

/// Job Objects of finished quests that still have live processes. Keyed by task id.
#[derive(Default)]
pub struct Registry(Mutex<HashMap<i64, Arc<Option<Job>>>>);

impl Registry {
    pub fn keep(&self, task_id: i64, job: Arc<Option<Job>>) {
        if let Some(old) = self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(task_id, job) {
            if let Some(j) = old.as_ref() {
                j.terminate(); // a re-run replaces the previous run's leftovers
            }
        }
    }
    pub fn pids(&self, task_id: i64) -> Vec<u32> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).get(&task_id).and_then(|j| j.as_ref().as_ref().map(Job::pids)).unwrap_or_default()
    }
    /// Stops one process this app owns. Refuses any pid that is not inside the quest's job.
    pub fn stop_pid(&self, task_id: i64, pid: u32) -> bool {
        if self.pids(task_id).contains(&pid) {
            kill_tree(pid);
            true
        } else {
            false
        }
    }
    pub fn stop_task(&self, task_id: i64) {
        if let Some(j) = self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&task_id) {
            if let Some(j) = j.as_ref() {
                j.terminate();
            }
        }
    }
    pub fn stop_all(&self) {
        for (_, j) in self.0.lock().unwrap_or_else(|p| p.into_inner()).drain() {
            if let Some(j) = j.as_ref() {
                j.terminate();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_local_urls_in_claude_output_and_normalises_them() {
        let t = "The dev server is ready.\nLocal: http://localhost:5173/  Network: http://0.0.0.0:5173, also see https://example.com/docs. Done at http://127.0.0.1:8080/app?x=1.";
        assert_eq!(detect_local_urls(t), vec!["http://localhost:5173/", "http://localhost:5173", "http://127.0.0.1:8080/app?x=1"]);
        assert!(detect_local_urls("no links here, port 3000").is_empty());
        assert_eq!(detect_urls("see https://example.com/docs.")[0], "https://example.com/docs");
    }

    #[test]
    fn only_plain_http_links_may_be_opened() {
        assert!(valid_open_url("http://localhost:3000/") && valid_open_url("https://example.com/a?b=c"));
        for bad in ["file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "ms-settings:", "http://a b/", "http://x\"y", "calc.exe", "", "http://x/\n"] {
            assert!(!valid_open_url(bad), "{bad}");
        }
        assert!(open_default("file:///C:/x").is_err() && open_in_chrome("javascript:1").is_err());
    }

    #[test]
    fn a_process_that_is_not_owned_cannot_be_stopped() {
        let r = Registry::default();
        assert!(!r.stop_pid(1, std::process::id()), "our own pid is not in any quest job");
        r.stop_task(1);
        r.stop_all();
    }
}
