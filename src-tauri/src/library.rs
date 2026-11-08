//! The Library: read-only discovery and reading of Markdown documentation inside the selected repository.
//! Only three locations are ever listed: `CLAUDE.md` at the root, other `*.md` files in the root, and `*.md`
//! files anywhere under the root `docs/` folder. Symlinks are never followed, sensitive names and generated
//! folders are skipped, and content is redacted with the same rules as the project profile.
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::db::LibraryMeta;
use crate::project_context::{is_sensitive_name, redact};

const MAX_DOCS: usize = 400;
const MAX_DEPTH: usize = 8;
const MAX_BYTES: usize = 400_000;

fn is_md(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".md") || n.ends_with(".markdown")
}

fn skipped_dir(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "node_modules" | ".git" | "target" | "dist" | "build" | "out" | "venv" | ".venv" | "__pycache__" | ".next" | "vendor" | ".cache") || name.starts_with('.')
}

fn modified_ms(p: &Path) -> i64 {
    std::fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Title = first `# heading` in the first 4 KB, else the file name without extension.
fn title_of(path: &Path) -> String {
    let fallback = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut buf = vec![0u8; 4096];
    let n = File::open(path).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).lines().find_map(|l| l.trim().strip_prefix("# ").map(|t| t.trim().trim_matches('#').trim().to_string())).filter(|t| !t.is_empty()).unwrap_or(fallback)
}

fn regular(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_file() && !m.file_type().is_symlink()).unwrap_or(false)
}

fn walk_docs(dir: &Path, root: &Path, rel: &str, depth: usize, out: &mut Vec<LibraryMeta>) {
    if depth > MAX_DEPTH || out.len() >= MAX_DOCS {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let rel_path = format!("{rel}/{name}");
        if meta.is_dir() {
            if !skipped_dir(&name) {
                walk_docs(&p, root, &rel_path, depth + 1, out);
            }
        } else if meta.is_file() && is_md(&name) && !is_sensitive_name(&name) && out.len() < MAX_DOCS {
            out.push(LibraryMeta { path: rel_path, title: title_of(&p), size: meta.len() as i64, modified: modified_ms(&p) });
        }
    }
}

/// CLAUDE.md first, then the other root Markdown files, then everything under docs/.
pub fn discover(root: &Path) -> Vec<LibraryMeta> {
    let mut out: Vec<LibraryMeta> = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    let mut roots: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (is_md(&name) && !is_sensitive_name(&name) && regular(&e.path())).then(|| (name, e.path()))
        })
        .collect();
    roots.sort_by(|a, b| (a.0 != "CLAUDE.md", a.0.to_ascii_lowercase()).cmp(&(b.0 != "CLAUDE.md", b.0.to_ascii_lowercase())));
    for (name, p) in roots {
        let size = std::fs::metadata(&p).map(|m| m.len() as i64).unwrap_or(0);
        out.push(LibraryMeta { path: name, title: title_of(&p), size, modified: modified_ms(&p) });
    }
    let docs = root.join("docs");
    if std::fs::symlink_metadata(&docs).map(|m| m.is_dir() && !m.file_type().is_symlink()).unwrap_or(false) {
        walk_docs(&docs, root, "docs", 0, &mut out);
    }
    out
}

/// Is this relative path one the shelves may show? (root *.md or docs/**/*.md, no traversal.)
pub fn allowed_path(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    if rel.is_empty() || rel.contains('\\') || rel.contains(':') || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") || !is_md(parts.last().copied().unwrap_or("")) {
        return false;
    }
    parts.len() == 1 || parts[0] == "docs"
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocContent {
    pub path: String,
    pub title: String,
    pub modified: i64,
    pub content: String,
    pub truncated: bool,
}

/// Reads one document (redacted, capped). Fails for anything outside the allowed locations or via symlinks.
pub fn read(root_in: &Path, rel: &str) -> Result<DocContent, String> {
    if !allowed_path(rel) {
        return Err("That file is not part of the library.".into());
    }
    let root = root_in.canonicalize().map_err(|e| format!("project folder is not readable: {e}"))?;
    let p = root.join(rel.replace('/', "\\"));
    if is_sensitive_name(rel.rsplit('/').next().unwrap_or("")) || !regular(&p) {
        return Err("That document cannot be opened.".into());
    }
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("That document is outside the project.".into());
    }
    let mut buf = Vec::new();
    File::open(&canon).map_err(|e| e.to_string())?.take(MAX_BYTES as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let truncated = buf.len() > MAX_BYTES;
    buf.truncate(MAX_BYTES);
    Ok(DocContent { path: rel.to_string(), title: title_of(&canon), modified: modified_ms(&canon), content: redact(&String::from_utf8_lossy(&buf)), truncated })
}

/// Fits a document into `budget` characters for ChatGPT without losing its shape: small documents go in whole;
/// big ones keep the outline of every heading plus as many full sections as fit (in order), and the remaining
/// sections are reduced to their heading and first lines, always marked so the model knows what is missing.
pub fn fit_document(content: &str, budget: usize) -> String {
    if content.chars().count() <= budget {
        return content.to_string();
    }
    let mut sections: Vec<(String, String)> = Vec::new();
    let (mut head, mut body) = (String::from("(start of document)"), String::new());
    let mut in_code = false;
    for line in content.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
        }
        if !in_code && line.starts_with('#') && line.trim_start_matches('#').starts_with(' ') {
            sections.push((std::mem::replace(&mut head, line.trim().to_string()), std::mem::take(&mut body)));
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    sections.push((head, body));
    let outline: String = sections.iter().map(|(h, _)| format!("- {h}\n")).collect();
    let mut out = format!("[Large document: shown in parts. Outline of ALL sections:\n{outline}]\n\n");
    let mut left = budget.saturating_sub(out.chars().count());
    let mut omitted = Vec::new();
    for (h, b) in &sections {
        let full = format!("{h}\n{b}\n");
        let n = full.chars().count();
        if n <= left {
            out.push_str(&full);
            left -= n;
        } else {
            let short: String = b.chars().take(300).collect();
            let piece = format!("{h}\n{short}\n[… section shortened; {} more characters in the original …]\n\n", b.chars().count().saturating_sub(300));
            let pn = piece.chars().count();
            if pn <= left {
                out.push_str(&piece);
                left -= pn;
            } else {
                omitted.push(h.clone());
            }
        }
    }
    if !omitted.is_empty() {
        out.push_str(&format!("[Sections not included because of the size limit: {}]\n", omitted.join(" | ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("mg-lib-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        std::fs::create_dir_all(d.join("docs/api")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("CLAUDE.md"), "# Constitution\nrules").unwrap();
        std::fs::write(d.join("README.md"), "# Readme\nSECRET_KEY=abcdef123456 here").unwrap();
        std::fs::write(d.join("zeta.md"), "no heading").unwrap();
        std::fs::write(d.join("secrets.md"), "# s").unwrap();
        std::fs::write(d.join("docs/architecture.md"), "# Architecture\n## Parts").unwrap();
        std::fs::write(d.join("docs/api/routes.md"), "# Routes").unwrap();
        std::fs::write(d.join("node_modules/x/README.md"), "# dep").unwrap();
        std::fs::write(d.join("src/notes.md"), "# not in the library").unwrap();
        d
    }

    #[test]
    fn discovery_lists_only_the_allowed_locations_in_order() {
        let d = temp_repo();
        let docs = discover(&d);
        std::fs::remove_dir_all(&d).ok();
        let paths: Vec<&str> = docs.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, ["CLAUDE.md", "README.md", "zeta.md", "docs/api/routes.md", "docs/architecture.md"]);
        assert_eq!(docs.iter().find(|x| x.path == "zeta.md").unwrap().title, "zeta", "file name is the title without a heading");
        assert_eq!(docs[0].title, "Constitution");
    }

    #[test]
    fn reading_is_confined_and_redacted() {
        let d = temp_repo();
        let ok = read(&d, "README.md").unwrap();
        assert!(ok.content.contains("[REDACTED]") && !ok.content.contains("abcdef123456"));
        for bad in ["src/notes.md", "../x.md", "docs/../README.md", "C:/x.md", "docs\\a.md", "secrets.md", "node_modules/x/README.md", "README.txt", ""] {
            assert!(read(&d, bad).is_err(), "must reject {bad}");
        }
        std::fs::remove_dir_all(&d).ok();
        assert!(allowed_path("docs/a/b/c.md") && allowed_path("A.md") && !allowed_path("src/a.md"));
    }

    #[test]
    fn big_documents_keep_an_outline_and_say_what_was_left_out() {
        let mut doc = String::from("# Title\nintro\n");
        for i in 0..40 {
            doc.push_str(&format!("## Section {i}\n{}\n", "text ".repeat(300)));
        }
        let fitted = fit_document(&doc, 6_000);
        assert!(fitted.chars().count() <= 6_500);
        assert!(fitted.contains("Outline of ALL sections") && fitted.contains("## Section 39"));
        assert!(fitted.contains("shortened") || fitted.contains("not included"));
        assert_eq!(fit_document("small", 100), "small");
    }
}
