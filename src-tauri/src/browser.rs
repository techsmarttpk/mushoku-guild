//! Claude in Chrome (official integration, `claude --chrome`). Mushoku Guild never controls the browser itself and
//! never touches the extension: it only detects the prerequisites, shows their state, opens the official
//! installation page on request, and passes `--chrome` to the user's own Claude Code when the user enabled it.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::events::hidden;

/// Chrome Web Store page of the official extension (from code.claude.com/docs/en/chrome).
pub const EXTENSION_URL: &str = "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn";
const EXTENSION_ID: &str = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const HOST_NAME: &str = "com.anthropic.claude_code_browser_extension";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub enabled: bool,
    pub cli_supported: bool,
    pub extension_installed: bool,
    pub native_host_registered: bool,
    pub chrome_running: bool,
    pub chrome_path: Option<String>,
    /// disabled | unsupported | extension_missing | chrome_not_running | ready
    pub state: String,
    pub message: String,
}

/// Pure decision so the fallback logic is testable. Only `ready` lets a quest pass `--chrome`.
pub fn decide(enabled: bool, cli_supported: bool, extension_installed: bool, chrome_running: bool) -> (&'static str, &'static str) {
    if !enabled {
        return ("disabled", "Browser support is off. Quests run without Claude in Chrome.");
    }
    if !cli_supported {
        return ("unsupported", "This Claude Code version has no Chrome integration (`--chrome`). Update with `claude update`; everything else keeps working.");
    }
    if !extension_installed {
        return ("extension_missing", "The Claude in Chrome extension was not found. Install it from the official page, or continue without browser support.");
    }
    if !chrome_running {
        return ("chrome_not_running", "Chrome is not running. Start it so Claude can use your browser (quests still run without it).");
    }
    ("ready", "Claude in Chrome is available. Claude asks before browser actions, and the extension keeps its own site permissions.")
}

fn cli_supports_chrome(exe: &Path) -> bool {
    static CACHE: OnceLock<Mutex<Option<(PathBuf, bool)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((p, v)) = cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if p == exe {
            return *v;
        }
    }
    let mut c = Command::new(exe);
    c.arg("--help");
    let v = crate::claude::capture(c, Duration::from_secs(20)).map(|(_, out)| out.contains("--chrome")).unwrap_or(false);
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((exe.to_path_buf(), v));
    v
}

fn browser_roots() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return vec![] };
    vec![local.join("Google/Chrome/User Data"), local.join("Microsoft/Edge/User Data"), local.join("BraveSoftware/Brave-Browser/User Data")]
}

/// The extension is installed when its folder exists in any browser profile (read-only directory check).
pub fn extension_installed() -> bool {
    browser_roots().iter().any(|root| {
        std::fs::read_dir(root)
            .map(|rd| rd.flatten().any(|p| p.path().join("Extensions").join(EXTENSION_ID).is_dir()))
            .unwrap_or(false)
    })
}

fn native_host_registered() -> bool {
    ["Google\\Chrome", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser"].iter().any(|b| {
        let mut c = Command::new("reg");
        c.args(["query", &format!("HKCU\\Software\\{b}\\NativeMessagingHosts\\{HOST_NAME}")]);
        matches!(crate::claude::capture(c, Duration::from_secs(5)), Some((0, _)))
    })
}

fn chrome_running() -> bool {
    let mut c = Command::new("tasklist");
    c.args(["/FI", "IMAGENAME eq chrome.exe", "/NH"]);
    crate::claude::capture(c, Duration::from_secs(8)).map(|(_, o)| o.to_ascii_lowercase().contains("chrome.exe")).unwrap_or(false)
}

pub fn chrome_path() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = vec![PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"), PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")];
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        cands.push(PathBuf::from(l).join("Google/Chrome/Application/chrome.exe"));
    }
    cands.into_iter().find(|p| p.is_file())
}

pub fn status(claude_exe: Option<&Path>, enabled: bool) -> BrowserStatus {
    let cli = claude_exe.map(cli_supports_chrome).unwrap_or(false);
    let ext = extension_installed();
    let running = chrome_running();
    let (state, message) = decide(enabled, cli, ext, running);
    BrowserStatus {
        enabled,
        cli_supported: cli,
        extension_installed: ext,
        native_host_registered: native_host_registered(),
        chrome_running: running,
        chrome_path: chrome_path().map(|p| p.display().to_string()),
        state: state.into(),
        message: message.into(),
    }
}

/// Should this quest start Claude with `--chrome`? Only when the user enabled it and the integration looks usable.
/// Chrome not running is fine: Claude Code starts normally and connects when the browser appears.
pub fn use_chrome_flag(claude_exe: &Path, enabled: bool) -> bool {
    enabled && cli_supports_chrome(claude_exe) && extension_installed()
}

pub fn open_chrome() -> Result<(), String> {
    let p = chrome_path().ok_or("Chrome was not found in its usual locations.")?;
    hidden(&mut Command::new(p)).spawn().map(|_| ()).map_err(|e| format!("could not start Chrome: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_states_fall_back_gracefully() {
        assert_eq!(decide(false, true, true, true).0, "disabled");
        assert_eq!(decide(true, false, true, true).0, "unsupported");
        assert_eq!(decide(true, true, false, true).0, "extension_missing");
        assert_eq!(decide(true, true, true, false).0, "chrome_not_running");
        assert_eq!(decide(true, true, true, true).0, "ready");
        assert!(decide(true, true, false, true).1.contains("continue without"));
    }

    #[test]
    fn the_install_link_is_the_official_store_page() {
        assert!(EXTENSION_URL.starts_with("https://chromewebstore.google.com/") && EXTENSION_URL.ends_with(EXTENSION_ID));
    }

    #[test]
    fn a_missing_cli_never_enables_the_flag() {
        assert!(!use_chrome_flag(Path::new("C:\\does-not-exist\\claude.exe"), true));
        assert!(!use_chrome_flag(Path::new("C:\\does-not-exist\\claude.exe"), false));
    }
}
