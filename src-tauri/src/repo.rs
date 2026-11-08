//! Repository identity and per-repository trust. A repository is a workspace: conversations, quests, research,
//! library and permission preferences all hang off one stable identity, not off the folder's display name.
//!
//! Identity = the first commit of the Git history (`git:<sha>`), which survives renaming or moving the folder.
//! Folders without Git fall back to `path:<normalised path>`, so a move is detected as "needs reconnecting".
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::db::{Db, Project};

pub fn norm_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

pub fn identity_of(path: &Path) -> String {
    let mut c = Command::new("git");
    c.args(["-c", "core.fsmonitor=false", "-C"]).arg(path).args(["rev-list", "--max-parents=0", "HEAD"]).env("GIT_OPTIONAL_LOCKS", "0");
    if let Some((0, out)) = crate::claude::capture(c, Duration::from_secs(8)) {
        let mut roots: Vec<&str> = out.lines().map(str::trim).filter(|l| l.len() >= 40 && l.chars().all(|ch| ch.is_ascii_hexdigit())).collect();
        roots.sort_unstable();
        if let Some(r) = roots.first() {
            return format!("git:{r}");
        }
    }
    format!("path:{}", norm_path(&path.display().to_string()))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TrustState {
    Untrusted,
    Trusted,
    /// Trust was granted, but the folder moved or its identity changed: ask again.
    Reconfirm,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrefsView {
    pub project_id: i64,
    pub trust: TrustState,
    pub policy: String,
    pub autopilot: bool,
    pub trusted_at: Option<i64>,
    pub identity: String,
    pub folder_exists: bool,
}

/// Pure trust decision so it can be tested without a filesystem.
pub fn trust_state(saved_trusted: bool, saved_identity: &str, saved_path: &str, current_identity: &str, current_path: &str, folder_exists: bool) -> TrustState {
    if !saved_trusted {
        return TrustState::Untrusted;
    }
    if folder_exists && saved_identity == current_identity && norm_path(saved_path) == norm_path(current_path) {
        TrustState::Trusted
    } else {
        TrustState::Reconfirm
    }
}

pub fn prefs_view(db: &Db, project: &Project) -> PrefsView {
    let folder_exists = Path::new(&project.path).is_dir();
    let identity = if folder_exists { identity_of(Path::new(&project.path)) } else { project.identity.clone() };
    match db.repo_prefs(project.id) {
        None => PrefsView { project_id: project.id, trust: TrustState::Untrusted, policy: "ask_each".into(), autopilot: false, trusted_at: None, identity, folder_exists },
        Some(p) => PrefsView {
            project_id: project.id,
            trust: trust_state(p.trusted, &p.trusted_identity, &p.trusted_path, &identity, &project.path, folder_exists),
            policy: p.policy,
            autopilot: p.autopilot,
            trusted_at: p.trusted_at,
            identity,
            folder_exists,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_requires_matching_identity_and_location() {
        assert_eq!(trust_state(false, "", "", "git:a", "C:\\p", true), TrustState::Untrusted);
        assert_eq!(trust_state(true, "git:a", "C:\\p", "git:a", "c:/p/", true), TrustState::Trusted);
        assert_eq!(trust_state(true, "git:a", "C:\\p", "git:a", "D:\\moved", true), TrustState::Reconfirm, "a moved folder must be reconfirmed");
        assert_eq!(trust_state(true, "git:a", "C:\\p", "git:b", "C:\\p", true), TrustState::Reconfirm, "a different repository in the same place too");
        assert_eq!(trust_state(true, "git:a", "C:\\p", "git:a", "C:\\p", false), TrustState::Reconfirm, "a missing folder cannot be trusted");
    }

    #[test]
    fn folders_without_git_get_a_path_identity() {
        let d = std::env::temp_dir().join(format!("mg-ident-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let id = identity_of(&d);
        std::fs::remove_dir_all(&d).ok();
        assert!(id.starts_with("path:"), "{id}");
    }

    #[test]
    fn this_repository_has_a_git_identity() {
        let id = identity_of(Path::new(env!("CARGO_MANIFEST_DIR")));
        assert!(id.starts_with("git:") && id.len() > 40, "{id}");
    }
}
