//! Repository file operations for the Repo tab. The frontend never touches the filesystem: it sends paths
//! relative to the selected repository and this module resolves them under strict rules.
//!
//! Rules: relative `/` paths only; no `..`, drive letters, absolute or UNC paths; `.git` is never reachable;
//! every existing target is canonicalised and must stay inside the canonical repository root (so symlinks and
//! junctions pointing outside are refused); huge or binary files are not loaded; saves detect external changes.
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

pub const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;
const LARGE_BYTES: u64 = 512 * 1024;
const PROTECTED: &[&str] = &[".gitignore", ".gitattributes", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "Cargo.lock", "pyproject.toml", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "CLAUDE.md", "README.md", "LICENSE", "tsconfig.json", "docker-compose.yml", "Dockerfile"];

#[derive(Debug, PartialEq)]
pub enum FsError {
    Invalid(String),
    NotFound,
    Conflict { current_mtime: i64 },
    TooLarge(u64),
    Binary,
    Exists,
    Protected(String),
    Io(String),
}

impl std::fmt::Display for FsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsError::Invalid(m) => write!(f, "{m}"),
            FsError::NotFound => write!(f, "That file or folder does not exist."),
            FsError::Conflict { .. } => write!(f, "The file changed on disk since you opened it."),
            FsError::TooLarge(n) => write!(f, "This file is {} MB, too large to edit here.", n / (1024 * 1024)),
            FsError::Binary => write!(f, "This looks like a binary file, so it is not opened in the editor."),
            FsError::Exists => write!(f, "Something with that name already exists."),
            FsError::Protected(n) => write!(f, "{n} is an important repository file. Confirm explicitly to delete it."),
            FsError::Io(m) => write!(f, "{m}"),
        }
    }
}

fn io(e: std::io::Error) -> FsError {
    FsError::Io(e.to_string())
}

/// Validates a repository-relative path and returns its normalised components.
pub fn clean_rel(rel: &str) -> Result<Vec<String>, FsError> {
    let raw = rel.trim();
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return Err(FsError::Invalid("Network paths are not allowed.".into()));
    }
    let r = raw.replace('\\', "/");
    let r = r.trim_matches('/');
    if r.is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for c in r.split('/') {
        if c.is_empty() || c == "." || c == ".." || c.contains(':') || c.chars().any(|ch| ch.is_control() || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*')) {
            return Err(FsError::Invalid("That path is not allowed.".into()));
        }
        if c.eq_ignore_ascii_case(".git") {
            return Err(FsError::Invalid("Git's own files are not editable here; use the Git tools.".into()));
        }
        let stem = c.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "LPT1" | "LPT2") || c.ends_with(' ') || c.ends_with('.') {
            return Err(FsError::Invalid("That name is reserved by Windows.".into()));
        }
        out.push(c.to_string());
    }
    Ok(out)
}

pub struct Root(PathBuf);

impl Root {
    pub fn open(path: &Path) -> Result<Root, FsError> {
        let c = path.canonicalize().map_err(|_| FsError::NotFound)?;
        if c.is_dir() { Ok(Root(c)) } else { Err(FsError::NotFound) }
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Resolves an EXISTING path (file or folder) and proves it is inside the repository after symlink resolution.
    pub fn existing(&self, rel: &str) -> Result<PathBuf, FsError> {
        let parts = clean_rel(rel)?;
        let mut p = self.0.clone();
        for c in &parts {
            p.push(c);
        }
        let canon = p.canonicalize().map_err(|_| FsError::NotFound)?;
        if !canon.starts_with(&self.0) {
            return Err(FsError::Invalid("That path leaves the repository.".into()));
        }
        Ok(canon)
    }

    /// Resolves a path that may not exist yet: its parent must exist inside the repository.
    pub fn creatable(&self, rel: &str) -> Result<PathBuf, FsError> {
        let parts = clean_rel(rel)?;
        let (name, parents) = parts.split_last().ok_or_else(|| FsError::Invalid("A name is required.".into()))?;
        let mut parent = self.0.clone();
        for c in parents {
            parent.push(c);
        }
        let parent = parent.canonicalize().map_err(|_| FsError::NotFound)?;
        if !parent.starts_with(&self.0) {
            return Err(FsError::Invalid("That path leaves the repository.".into()));
        }
        Ok(parent.join(name))
    }
}

fn mtime(p: &Path) -> i64 {
    fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub rel: String,
    pub is_dir: bool,
    pub size: u64,
    pub hidden: bool,
    pub ignored: bool,
    pub link: bool,
}

/// Lists one directory. `ignored` marks names matched by the repository's ignore rules (computed by the caller).
pub fn list_dir(root: &Root, rel: &str, show_hidden: bool, ignored: &dyn Fn(&[String]) -> Vec<String>, show_ignored: bool) -> Result<Vec<Entry>, FsError> {
    let dir = root.existing(rel)?;
    if !dir.is_dir() {
        return Err(FsError::Invalid("Not a folder.".into()));
    }
    let prefix = clean_rel(rel)?.join("/");
    let mut raw = Vec::new();
    for e in fs::read_dir(&dir).map_err(io)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(e.path()) else { continue };
        let hidden = name.starts_with('.');
        if hidden && !show_hidden {
            continue;
        }
        let rel_path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        raw.push(Entry { name, rel: rel_path, is_dir: meta.is_dir() && !meta.file_type().is_symlink(), size: if meta.is_file() { meta.len() } else { 0 }, hidden, ignored: false, link: meta.file_type().is_symlink() });
    }
    let names: Vec<String> = raw.iter().map(|e| e.rel.clone()).collect();
    let ign = ignored(&names);
    for e in &mut raw {
        e.ignored = ign.contains(&e.rel);
    }
    if !show_ignored {
        raw.retain(|e| !e.ignored);
    }
    raw.sort_by(|a, b| (!a.is_dir, a.name.to_ascii_lowercase()).cmp(&(!b.is_dir, b.name.to_ascii_lowercase())));
    Ok(raw)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileData {
    pub rel: String,
    pub content: String,
    pub mtime: i64,
    pub size: u64,
    pub large: bool,
    pub crlf: bool,
}

pub fn read_file(root: &Root, rel: &str) -> Result<FileData, FsError> {
    let p = root.existing(rel)?;
    let meta = fs::metadata(&p).map_err(io)?;
    if !meta.is_file() {
        return Err(FsError::Invalid("Not a file.".into()));
    }
    if meta.len() > MAX_EDIT_BYTES {
        return Err(FsError::TooLarge(meta.len()));
    }
    let mut buf = Vec::new();
    File::open(&p).map_err(io)?.read_to_end(&mut buf).map_err(io)?;
    if buf.iter().take(8192).any(|b| *b == 0) {
        return Err(FsError::Binary);
    }
    let text = String::from_utf8(buf).map_err(|_| FsError::Binary)?;
    let crlf = text.contains("\r\n");
    Ok(FileData { rel: clean_rel(rel)?.join("/"), content: if crlf { text.replace("\r\n", "\n") } else { text }, mtime: mtime(&p), size: meta.len(), large: meta.len() > LARGE_BYTES, crlf })
}

/// Saves a file. `expected_mtime` is the modification time the editor last saw; a different value means someone else
/// changed the file, and the save is refused unless `force` is set (the user chose to overwrite).
pub fn write_file(root: &Root, rel: &str, content: &str, crlf: bool, expected_mtime: Option<i64>, force: bool) -> Result<i64, FsError> {
    let p = root.existing(rel)?;
    if let Some(exp) = expected_mtime {
        let cur = mtime(&p);
        if cur != exp && !force {
            return Err(FsError::Conflict { current_mtime: cur });
        }
    }
    let data = if crlf { content.replace("\r\n", "\n").replace('\n', "\r\n") } else { content.to_string() };
    // write to a temp file next to it and replace, so a crash never leaves half a file
    let tmp = p.with_extension(format!("mg-save-{}", std::process::id()));
    let mut f = File::create(&tmp).map_err(io)?;
    f.write_all(data.as_bytes()).map_err(io)?;
    f.sync_all().map_err(io)?;
    drop(f);
    if let Err(e) = fs::rename(&tmp, &p) {
        let _ = fs::remove_file(&tmp);
        return Err(io(e));
    }
    Ok(mtime(&p))
}

pub fn create(root: &Root, rel: &str, is_dir: bool) -> Result<(), FsError> {
    let p = root.creatable(rel)?;
    if p.exists() {
        return Err(FsError::Exists);
    }
    if is_dir { fs::create_dir(&p).map_err(io) } else { File::create_new(&p).map(|_| ()).map_err(io) }
}

pub fn rename(root: &Root, from: &str, to: &str) -> Result<(), FsError> {
    let src = root.existing(from)?;
    if src == *root.path() {
        return Err(FsError::Invalid("The repository root cannot be renamed here.".into()));
    }
    let dst = root.creatable(to)?;
    if dst.exists() {
        return Err(FsError::Exists);
    }
    fs::rename(src, dst).map_err(io)
}

pub fn is_protected(rel: &str) -> bool {
    clean_rel(rel).ok().and_then(|p| if p.len() == 1 { p.into_iter().next() } else { None }).map(|n| PROTECTED.iter().any(|x| x.eq_ignore_ascii_case(&n))).unwrap_or(false)
}

/// Deletes a file or folder (permanent). The repository root and `.git` are never deletable; important files need
/// `confirm_important`.
pub fn delete(root: &Root, rel: &str, confirm_important: bool) -> Result<(), FsError> {
    if clean_rel(rel)?.is_empty() {
        return Err(FsError::Invalid("The repository root cannot be deleted.".into()));
    }
    if is_protected(rel) && !confirm_important {
        return Err(FsError::Protected(rel.to_string()));
    }
    let p = root.existing(rel)?;
    let meta = fs::symlink_metadata(&p).map_err(io)?;
    if meta.is_dir() { fs::remove_dir_all(&p).map_err(io) } else { fs::remove_file(&p).map_err(io) }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub rel: String,
    pub mtime: i64,
    pub exists: bool,
}

pub fn stat_many(root: &Root, rels: &[String]) -> Vec<Stat> {
    rels.iter()
        .map(|r| match root.existing(r) {
            Ok(p) => Stat { rel: r.clone(), mtime: mtime(&p), exists: true },
            Err(_) => Stat { rel: r.clone(), mtime: 0, exists: false },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> (PathBuf, Root) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("mg-fs-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        fs::create_dir_all(d.join("src")).unwrap();
        fs::create_dir_all(d.join(".git")).unwrap();
        fs::write(d.join("src/a.ts"), "let a = 1;\r\nlet b = 2;\r\n").unwrap();
        fs::write(d.join("README.md"), "# hi").unwrap();
        fs::write(d.join(".hidden"), "x").unwrap();
        fs::write(d.join("bin.dat"), [0u8, 1, 2, 0, 3]).unwrap();
        let root = Root::open(&d).unwrap();
        (d, root)
    }

    #[test]
    fn traversal_absolute_drive_git_and_reserved_names_are_rejected() {
        for bad in ["../x", "src/../../x", "..", "C:/Windows/win.ini", "C:\\x", "\\\\server\\share\\x", "/etc/passwd", ".git/config", "src/.GIT/hooks", ".git", "a/./b", "src//b", "con", "nul.txt", "a:b", "name?", "trail."] {
            let r = clean_rel(bad);
            assert!(r.is_err() || bad == "/etc/passwd" && r.as_ref().map(|v| v == &vec!["etc".to_string(), "passwd".to_string()]).unwrap_or(false), "{bad} -> {r:?}");
        }
        assert_eq!(clean_rel("src\\a.ts").unwrap(), vec!["src", "a.ts"]);
        assert_eq!(clean_rel("").unwrap().len(), 0);
        let (d, root) = repo();
        assert!(root.existing("../").is_err() && root.existing(".git/config").is_err() && root.creatable("../evil.txt").is_err());
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn a_leading_slash_is_treated_as_relative_to_the_repository_not_the_machine() {
        let (d, root) = repo();
        assert!(root.existing("/etc/passwd").is_err(), "does not exist inside the repository");
        assert!(root.existing("/src/a.ts").is_ok(), "stays under the root");
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn symlinks_leaving_the_repository_are_refused() {
        let (d, root) = repo();
        let outside = std::env::temp_dir().join(format!("mg-outside-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        let link = d.join("escape");
        if std::os::windows::fs::symlink_dir(&outside, &link).is_ok() {
            assert!(root.existing("escape/secret.txt").is_err(), "must not read through the link");
            assert!(root.creatable("escape/new.txt").is_err(), "must not create through the link");
            let listed = list_dir(&root, "", true, &|_| vec![], true).unwrap();
            assert!(listed.iter().find(|e| e.name == "escape").map(|e| e.link && !e.is_dir).unwrap_or(true), "a link is shown as a link, never traversed");
        }
        fs::remove_dir_all(&outside).ok();
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn listing_hides_git_hidden_and_ignored_entries_unless_asked() {
        let (d, root) = repo();
        let ignore = |names: &[String]| names.iter().filter(|n| n.ends_with("bin.dat")).cloned().collect::<Vec<_>>();
        let plain: Vec<String> = list_dir(&root, "", false, &ignore, false).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(plain, vec!["src", "README.md"], "folders first, no .git, no hidden, no ignored");
        let all: Vec<String> = list_dir(&root, "", true, &ignore, true).unwrap().into_iter().map(|e| e.name).collect();
        assert!(all.contains(&".hidden".to_string()) && all.contains(&"bin.dat".to_string()) && !all.contains(&".git".to_string()));
        assert!(list_dir(&root, "src", false, &ignore, false).unwrap().iter().any(|e| e.rel == "src/a.ts"));
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn reading_refuses_binary_and_huge_files_and_normalises_line_endings() {
        let (d, root) = repo();
        assert_eq!(read_file(&root, "bin.dat").unwrap_err(), FsError::Binary);
        let big = d.join("big.txt");
        fs::write(&big, vec![b'a'; (MAX_EDIT_BYTES + 1) as usize]).unwrap();
        assert!(matches!(read_file(&root, "big.txt"), Err(FsError::TooLarge(_))));
        let f = read_file(&root, "src/a.ts").unwrap();
        assert!(f.crlf && f.content == "let a = 1;\nlet b = 2;\n");
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn saving_changes_the_real_file_keeps_crlf_and_detects_external_changes() {
        let (d, root) = repo();
        let f = read_file(&root, "src/a.ts").unwrap();
        let m2 = write_file(&root, "src/a.ts", "let a = 5;\nlet b = 2;\n", f.crlf, Some(f.mtime), false).unwrap();
        assert_eq!(fs::read_to_string(d.join("src/a.ts")).unwrap(), "let a = 5;\r\nlet b = 2;\r\n", "the file on disk really changed, original line endings kept");
        // someone else edits the file
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(d.join("src/a.ts"), "changed elsewhere").unwrap();
        let err = write_file(&root, "src/a.ts", "mine", false, Some(m2), false).unwrap_err();
        assert!(matches!(err, FsError::Conflict { .. }), "{err:?}");
        assert_eq!(fs::read_to_string(d.join("src/a.ts")).unwrap(), "changed elsewhere", "nothing was overwritten");
        write_file(&root, "src/a.ts", "mine", false, Some(m2), true).unwrap();
        assert_eq!(fs::read_to_string(d.join("src/a.ts")).unwrap(), "mine");
        assert!(root.path().read_dir().unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("mg-save")), "no temp file left behind");
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn create_rename_delete_follow_the_safety_rules() {
        let (d, root) = repo();
        create(&root, "src/new.ts", false).unwrap();
        create(&root, "src/pkg", true).unwrap();
        assert_eq!(create(&root, "src/new.ts", false).unwrap_err(), FsError::Exists);
        assert!(create(&root, "../outside.txt", false).is_err() && create(&root, ".git/x", false).is_err());
        rename(&root, "src/new.ts", "src/renamed.ts").unwrap();
        assert!(d.join("src/renamed.ts").exists() && !d.join("src/new.ts").exists());
        assert!(rename(&root, "src/renamed.ts", "../escaped.ts").is_err());
        assert_eq!(rename(&root, "src/renamed.ts", "src/a.ts").unwrap_err(), FsError::Exists, "never overwrites on rename");
        assert!(delete(&root, "", false).is_err() && delete(&root, ".git", true).is_err());
        assert!(matches!(delete(&root, "README.md", false), Err(FsError::Protected(_))));
        assert!(d.join("README.md").exists());
        delete(&root, "README.md", true).unwrap();
        delete(&root, "src", false).unwrap();
        assert!(!d.join("src").exists());
        assert!(is_protected("package.json") && !is_protected("src/package.json"));
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn stat_reports_existence_and_modification_time() {
        let (d, root) = repo();
        let s = stat_many(&root, &["README.md".into(), "gone.txt".into(), "../x".into()]);
        assert!(s[0].exists && s[0].mtime > 0 && !s[1].exists && !s[2].exists);
        fs::remove_dir_all(d).ok();
    }
}
