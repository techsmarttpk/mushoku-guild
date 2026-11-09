//! Local, sanitized project context profile for the Reasoner. Rust reads a small allowlisted set of files from
//! the selected project, redacts secret-looking strings and returns one text block. ChatGPT never gets
//! filesystem access: it only receives this text when the user asks for a prompt.
//!
//! Rules: allowlist for file CONTENTS (manifests and overview docs only), denylist for directories and
//! sensitive names, symlinks are never followed, everything is size-capped, secrets are redacted.
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use regex::Regex;
use serde::Serialize;

use crate::db::now_ms;

const MAX_TOTAL: usize = 26_000;
const MAX_DOC: usize = 5_000;
const MAX_MANIFEST: usize = 3_500;
const TREE_DEPTH: usize = 3;
const TREE_MAX_ENTRIES: usize = 140;
const TREE_PER_DIR: usize = 24;

const DENY_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", "out", ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", "coverage",
    ".idea", ".vscode", "bin", "obj", ".gradle", "vendor", ".cache", ".turbo", ".svelte-kit", ".parcel-cache", "site-packages", ".tox",
    ".mypy_cache", ".pytest_cache", "tmp", "temp", "logs", ".terraform", ".aws", ".ssh", ".gnupg",
];
const DENY_EXT: &[&str] = &[
    "pem", "key", "p12", "pfx", "crt", "cer", "der", "jks", "keystore", "kdbx", "sqlite", "sqlite3", "db", "log", "lock", "zip", "gz", "tar",
    "7z", "rar", "exe", "dll", "so", "dylib", "bin", "png", "jpg", "jpeg", "gif", "ico", "bmp", "webp", "pdf", "mp3", "mp4", "wav", "ttf", "otf",
    "woff", "woff2", "csv", "parquet", "pyc", "class", "jar", "ovpn", "tfstate",
];
const MANIFESTS: &[&str] = &[
    "package.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
    "go.mod", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "composer.json", "Gemfile", "tsconfig.json", "pubspec.yaml", "CMakeLists.txt", "Makefile", "docker-compose.yml",
];
const DOCS: &[&str] = &[
    "README.md", "README", "readme.md", "README.txt", "CLAUDE.md", "AGENTS.md", "ARCHITECTURE.md", "docs/architecture.md", "docs/ARCHITECTURE.md",
    "CONTRIBUTING.md",
];
const ENTRY_POINTS: &[&str] = &[
    "src/main.rs", "src/lib.rs", "src-tauri/src/main.rs", "src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx", "src/index.js",
    "src/App.tsx", "src/App.jsx", "src/App.vue", "src/app.ts", "index.js", "index.ts", "server.js", "app.js", "main.py", "app.py", "manage.py",
    "src/main.py", "main.go", "cmd", "src/main/java", "src/main/kotlin", "Program.cs", "index.html", "pages", "app",
];
const KEY_DIRS: &[&str] = &["src", "app", "lib", "api", "server", "client", "frontend", "backend", "tests", "test", "docs", "packages", "cmd", "internal", "scripts"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    /// "ready" | "stale" (project changed since collection) | "unavailable"
    pub status: String,
    pub text: String,
    pub collected_at: i64,
    pub sources: Vec<String>,
    pub truncated: bool,
    pub error: Option<String>,
}

struct Cached {
    info: ContextInfo,
    fingerprint: String,
}

#[derive(Default)]
pub struct ContextCache(Mutex<HashMap<i64, Cached>>);

impl ContextCache {
    /// Returns cached context (marking it stale if the project changed) or collects it. `refresh` forces a rescan.
    pub fn get(&self, project_id: i64, root: &Path, refresh: bool) -> ContextInfo {
        let fp = fingerprint(root);
        {
            let map = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(c) = map.get(&project_id) {
                if !refresh {
                    let mut info = c.info.clone();
                    if info.status == "ready" && c.fingerprint != fp {
                        info.status = "stale".into();
                    }
                    return info;
                }
            }
        }
        let info = match collect(root) {
            Ok((text, sources, truncated)) => ContextInfo { status: "ready".into(), text, collected_at: now_ms(), sources, truncated, error: None },
            Err(m) => ContextInfo { status: "unavailable".into(), text: String::new(), collected_at: now_ms(), sources: vec![], truncated: false, error: Some(m) },
        };
        self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(project_id, Cached { info: info.clone(), fingerprint: fp });
        info
    }
}

// ---------------------------------------------------------------- sanitising

fn redactors() -> &'static Vec<(Regex, &'static str)> {
    static R: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    R.get_or_init(|| {
        let mk = |p: &str, r: &'static str| (Regex::new(p).expect("valid redaction regex"), r);
        vec![
            mk(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)", "[REDACTED PRIVATE KEY]"),
            mk(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*", "[REDACTED JWT]"),
            mk(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{16,}", "[REDACTED KEY]"),
            mk(r"\bgh[pousr]_[A-Za-z0-9]{20,}", "[REDACTED TOKEN]"),
            mk(r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED KEY]"),
            mk(r"\bxox[baprs]-[A-Za-z0-9-]{10,}", "[REDACTED TOKEN]"),
            mk(r"://[^/\s:@]+:[^/\s@]+@", "://[REDACTED]@"),
            mk(
                r#"(?i)\b([a-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|authorization|private[_-]?key|access[_-]?key)[a-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}"#,
                "$1$2$3[REDACTED]",
            ),
        ]
    })
}

pub fn redact(s: &str) -> String {
    let mut out = s.to_string();
    for (re, rep) in redactors() {
        out = re.replace_all(&out, *rep).into_owned();
    }
    out
}

/// True for names that must never be listed or read (credentials, keys, env files, stores).
pub fn is_sensitive_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n == ".env" || n.starts_with(".env.") || n.ends_with(".env") {
        return true;
    }
    if matches!(n.as_str(), ".npmrc" | ".pypirc" | ".netrc" | ".htpasswd" | "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519" | ".git-credentials" | "terraform.tfvars") {
        return true;
    }
    if n.starts_with("id_rsa") || n.contains("credential") || n.contains("secret") || n.contains("password") || n.contains("private") || n.contains("token") {
        return true;
    }
    if let Some(ext) = n.rsplit('.').next().filter(|_| n.contains('.')) {
        if DENY_EXT.contains(&ext) {
            return true;
        }
    }
    false
}

pub(crate) fn is_denied_dir(name: &str) -> bool {
    DENY_DIRS.contains(&name.to_ascii_lowercase().as_str()) || (name.starts_with('.') && name != ".github")
}

/// Reads at most `max` bytes of a regular, non-symlink, non-binary file that really lives under `root`.
fn read_capped(root: &Path, path: &Path, max: usize) -> Option<(String, bool)> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    if is_sensitive_name(&name) {
        return None;
    }
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    let canon = path.canonicalize().ok()?;
    if !canon.starts_with(root) {
        return None;
    }
    let mut buf = Vec::new();
    File::open(&canon).ok()?.take(max as u64 + 1).read_to_end(&mut buf).ok()?;
    if buf.contains(&0) {
        return None;
    }
    let truncated = buf.len() > max;
    buf.truncate(max);
    let text = String::from_utf8_lossy(&buf).into_owned();
    Some((redact(&text), truncated))
}

fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{} …[truncated]", s.chars().take(max).collect::<String>())
    }
}

// ---------------------------------------------------------------- collection

fn summarize_package_json(text: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return cap(text, MANIFEST_RAW) };
    let mut out = String::new();
    for k in ["name", "version", "description", "type", "main"] {
        if let Some(x) = v[k].as_str() {
            out.push_str(&format!("{k}: {x}\n"));
        }
    }
    if let Some(s) = v["scripts"].as_object() {
        out.push_str("scripts:\n");
        for (k, c) in s.iter().take(20) {
            out.push_str(&format!("  {k}: {}\n", cap(c.as_str().unwrap_or(""), 100)));
        }
    }
    for k in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(d) = v[k].as_object() {
            let list: Vec<String> = d.iter().take(60).map(|(n, r)| format!("{n}@{}", r.as_str().unwrap_or("?"))).collect();
            out.push_str(&format!("{k}: {}\n", list.join(", ")));
        }
    }
    out
}
const MANIFEST_RAW: usize = MAX_MANIFEST;

fn git_text(root: &Path) -> Option<String> {
    let run = |args: &[&str]| -> Option<String> {
        let mut c = Command::new("git");
        // never let a repository config run commands (fsmonitor/hooks) while we only want to read state
        c.args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL", "-C"]).arg(root).args(args).env("GIT_OPTIONAL_LOCKS", "0");
        let (code, out) = crate::claude::capture(c, Duration::from_secs(8))?;
        (code == 0).then_some(out)
    };
    let branch = run(&["rev-parse", "--abbrev-ref", "HEAD"])?;
    let mut s = format!("branch: {}\n", branch.trim());
    if let Some(log) = run(&["log", "-n", "8", "--pretty=format:%h %s"]) {
        s.push_str("recent commits:\n");
        for l in log.lines().take(8) {
            s.push_str(&format!("  {}\n", cap(&redact(l), 110)));
        }
    }
    if let Some(st) = run(&["status", "--porcelain"]) {
        let lines: Vec<&str> = st
            .lines()
            .filter(|l| l.len() > 3 && !is_sensitive_name(l[3..].rsplit(['/', '\\']).next().unwrap_or("")))
            .collect();
        if lines.is_empty() {
            s.push_str("working tree: clean\n");
        } else {
            s.push_str(&format!("working tree: {} changed file(s)\n", lines.len()));
            for l in lines.iter().take(15) {
                s.push_str(&format!("  {}\n", cap(l, 110)));
            }
        }
    }
    Some(s)
}

fn tree_text(root: &Path) -> String {
    let mut out = String::new();
    let mut budget = TREE_MAX_ENTRIES;
    fn walk(dir: &Path, root: &Path, depth: usize, indent: usize, budget: &mut usize, out: &mut String) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
            if meta.file_type().is_symlink() {
                continue; // never follow links (they may leave the project)
            }
            if meta.is_dir() {
                if !is_denied_dir(&name) {
                    dirs.push(name);
                }
            } else if meta.is_file() && !is_sensitive_name(&name) && !name.starts_with('.') {
                files.push(name);
            }
        }
        dirs.sort();
        files.sort();
        let total = dirs.len() + files.len();
        let items: Vec<(String, bool)> = dirs.into_iter().map(|d| (d, true)).chain(files.into_iter().map(|f| (f, false))).collect();
        for (n, is_dir) in items.iter().take(TREE_PER_DIR) {
            if *budget == 0 {
                return;
            }
            *budget -= 1;
            out.push_str(&format!("{}{}{}\n", "  ".repeat(indent), n, if *is_dir { "/" } else { "" }));
            if *is_dir && depth + 1 < TREE_DEPTH {
                walk(&dir.join(n), root, depth + 1, indent + 1, budget, out);
            }
        }
        if total > TREE_PER_DIR {
            out.push_str(&format!("{}… (+{} more)\n", "  ".repeat(indent), total - TREE_PER_DIR));
        }
    }
    walk(root, root, 0, 0, &mut budget, &mut out);
    out
}

/// Builds the sanitized context text. Returns (text, source files used, truncated).
pub fn collect(root_in: &Path) -> Result<(String, Vec<String>, bool), String> {
    let root = root_in.canonicalize().map_err(|e| format!("project folder is not readable: {e}"))?;
    if !root.is_dir() {
        return Err("project path is not a folder".into());
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut sources: Vec<String> = Vec::new();
    let mut text = String::new();
    text.push_str(&format!("Project name: {name}\nProject folder: {}\n", root_in.display()));

    if let Some(g) = git_text(&root) {
        text.push_str("\n## Git\n");
        text.push_str(&g);
        sources.push("git (branch, last commits, status)".into());
    }

    text.push_str("\n## Languages, frameworks and dependencies (from manifests)\n");
    let mut any = false;
    for m in MANIFESTS {
        let p = root.join(m);
        if let Some((body, _)) = read_capped(&root, &p, if *m == "package.json" { 60_000 } else { MAX_MANIFEST }) {
            any = true;
            let shown = if *m == "package.json" { summarize_package_json(&body) } else { cap(&body, MAX_MANIFEST) };
            text.push_str(&format!("### {m}\n{}\n", shown.trim_end()));
            sources.push((*m).to_string());
        }
    }
    if !any {
        text.push_str("(no recognised manifest found at the project root)\n");
    }

    let mut entries: Vec<String> = ENTRY_POINTS.iter().filter(|e| std::fs::symlink_metadata(root.join(e)).map(|m| !m.file_type().is_symlink()).unwrap_or(false)).map(|s| s.to_string()).collect();
    entries.dedup();
    let dirs: Vec<String> = KEY_DIRS.iter().filter(|d| root.join(d).is_dir()).map(|s| s.to_string()).collect();
    text.push_str("\n## Entry points and key directories\n");
    text.push_str(&format!("entry points present: {}\n", if entries.is_empty() { "none detected".into() } else { entries.join(", ") }));
    text.push_str(&format!("key directories: {}\n", if dirs.is_empty() { "none detected".into() } else { dirs.join(", ") }));

    text.push_str("\n## Directory tree (depth 3, generated/vendor/hidden/sensitive entries omitted)\n");
    text.push_str(&tree_text(&root));
    sources.push("directory listing".into());

    let mut truncated = false;
    text.push_str("\n## Overview and architecture documentation\n");
    let mut doc_any = false;
    for d in DOCS {
        if let Some((body, cut)) = read_capped(&root, &root.join(d), MAX_DOC) {
            doc_any = true;
            truncated |= cut;
            text.push_str(&format!("### {d}{}\n{}\n", if cut { " (first part)" } else { "" }, body.trim_end()));
            sources.push((*d).to_string());
        }
    }
    if let Ok(rd) = std::fs::read_dir(root.join("docs")) {
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".md") && !is_sensitive_name(n)).collect();
        names.sort();
        if !names.is_empty() {
            text.push_str(&format!("other docs in docs/: {}\n", names.into_iter().take(30).collect::<Vec<_>>().join(", ")));
        }
    }
    if !doc_any {
        text.push_str("(no README or architecture document found)\n");
    }

    let text = redact(&text);
    if text.chars().count() > MAX_TOTAL {
        truncated = true;
        return Ok((cap(&text, MAX_TOTAL), sources, truncated));
    }
    Ok((text, sources, truncated))
}

/// Cheap change detector: key file mtimes/sizes plus the git HEAD pointer. No content is read.
pub fn fingerprint(root: &Path) -> String {
    let mut s = String::new();
    let stamp = |p: PathBuf, s: &mut String| {
        if let Ok(m) = std::fs::symlink_metadata(&p) {
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            s.push_str(&format!("{}:{}:{};", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), t, m.len()));
        }
    };
    for f in MANIFESTS.iter().chain(DOCS.iter()) {
        stamp(root.join(f), &mut s);
    }
    stamp(root.to_path_buf(), &mut s);
    if let Ok(head) = std::fs::read_to_string(root.join(".git").join("HEAD")) {
        s.push_str(head.trim());
        if let Some(r) = head.trim().strip_prefix("ref: ") {
            stamp(root.join(".git").join(r), &mut s);
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("mg-ctx-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/dep")).unwrap();
        std::fs::create_dir_all(d.join("target/debug")).unwrap();
        std::fs::write(d.join("package.json"), r#"{"name":"demo","scripts":{"dev":"vite"},"dependencies":{"react":"^19.0.0"},"apiKey":"sk-abcdefghijklmnopqrstuvwxyz123456"}"#).unwrap();
        std::fs::write(d.join("README.md"), "# Demo\nUses React. API_KEY=supersecretvalue123\nsee postgres://admin:hunter2@db.local/x\n").unwrap();
        std::fs::write(d.join(".env"), "DATABASE_PASSWORD=topsecret\n").unwrap();
        std::fs::write(d.join("server.pem"), "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n").unwrap();
        std::fs::write(d.join("credentials.json"), "{\"token\":\"abc123456\"}").unwrap();
        std::fs::write(d.join("src/main.tsx"), "console.log(1)").unwrap();
        std::fs::write(d.join("node_modules/dep/index.js"), "x").unwrap();
        std::fs::write(d.join("target/debug/app.exe"), "x").unwrap();
        d
    }

    #[test]
    fn context_includes_stack_and_excludes_secrets_and_generated_dirs() {
        let d = temp_project();
        let (text, sources, _) = collect(&d).unwrap();
        std::fs::remove_dir_all(&d).ok();
        assert!(text.contains("react@^19.0.0") && text.contains("vite"), "stack missing:\n{text}");
        assert!(text.contains("src/") && text.contains("main.tsx"));
        assert!(sources.iter().any(|s| s == "README.md"));
        for forbidden in ["supersecretvalue123", "hunter2", "topsecret", "BEGIN PRIVATE KEY", "abcdefghijklmnopqrstuvwxyz", "credentials.json", "server.pem", ".env", "node_modules", "app.exe"] {
            assert!(!text.contains(forbidden), "leaked {forbidden}:\n{text}");
        }
    }

    #[test]
    fn sensitive_names_and_redaction() {
        for n in [".env", ".env.local", "prod.env", "id_rsa", "server.key", "cert.pem", "my-credentials.json", ".npmrc", "secrets.yml", "data.sqlite"] {
            assert!(is_sensitive_name(n), "{n}");
        }
        for n in ["README.md", "package.json", "main.rs", "App.tsx"] {
            assert!(!is_sensitive_name(n), "{n}");
        }
        let r = redact("token = abcd1234efgh and ghp_abcdefghijklmnopqrstuvwxyz1234 and AKIAABCDEFGHIJKLMNOP");
        assert!(!r.contains("abcd1234efgh") && !r.contains("ghp_abc") && !r.contains("AKIAABC"));
    }

    #[test]
    fn cache_marks_changes_stale_and_missing_folder_unavailable() {
        let d = temp_project();
        let cache = ContextCache::default();
        assert_eq!(cache.get(1, &d, false).status, "ready");
        std::thread::sleep(Duration::from_millis(1100));
        std::fs::write(d.join("README.md"), "# Changed\n").unwrap();
        assert_eq!(cache.get(1, &d, false).status, "stale");
        assert_eq!(cache.get(1, &d, true).status, "ready");
        std::fs::remove_dir_all(&d).ok();
        let gone = cache.get(2, &d.join("nope"), true);
        assert_eq!(gone.status, "unavailable");
        assert!(gone.error.is_some());
    }
}
