//! Context selection (ADR-0015): the user decides, for every request, how much of the repository a model may see.
//!
//! * `none`     - nothing about the project is sent. This module does not even touch the file system.
//! * `capsule`  - a small summary generated locally from a fixed allowlist of metadata files (about 1,000 tokens).
//! * `relevant` - the capsule plus excerpts of files that match the request by local keyword search (about 4,000 tokens).
//! * `deep`     - the capsule plus an explicit, visible Claude Code investigation (read-only) run by the caller.
//!
//! Everything is assembled by Rust from the local checkout. Secrets, credential files, dependencies, build output and
//! binary/generated files are never read; text is redacted before it leaves this module. Token counts are estimates
//! (about four characters per token), used as budgets, not guarantees.
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::db::Db;
use crate::project_context::{is_denied_dir, is_sensitive_name, redact};

pub const DEFAULT_CAPSULE_TOKENS: usize = 1_000;
pub const DEFAULT_RELEVANT_TOKENS: usize = 4_000;
const MAX_FILES: usize = 6_000;
const MAX_READ_FILES: usize = 800;
const MAX_FILE_BYTES: u64 = 200_000;
const MAX_DEPTH: usize = 8;
const CHUNK_LINES: usize = 40;
const WALK_BUDGET: Duration = Duration::from_millis(2500);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    None,
    Capsule,
    Relevant,
    Deep,
}

impl Mode {
    /// Unknown text maps to the lightweight default, never to something that sends more.
    pub fn parse(s: &str) -> Mode {
        match s.trim() {
            "none" => Mode::None,
            "relevant" => Mode::Relevant,
            "deep" => Mode::Deep,
            _ => Mode::Capsule,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::None => "none",
            Mode::Capsule => "capsule",
            Mode::Relevant => "relevant",
            Mode::Deep => "deep",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    pub capsule: usize,
    pub relevant: usize,
}

impl Budgets {
    pub fn load(db: &Db) -> Budgets {
        let n = |k: &str, d: usize, lo: usize, hi: usize| db.setting(k).and_then(|s| s.parse::<usize>().ok()).unwrap_or(d).clamp(lo, hi);
        Budgets { capsule: n("ctx_budget_capsule", DEFAULT_CAPSULE_TOKENS, 200, 3_000), relevant: n("ctx_budget_relevant", DEFAULT_RELEVANT_TOKENS, 500, 12_000) }
    }
}

pub fn approx_tokens(s: &str) -> usize {
    s.chars().count().div_ceil(4)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assembled {
    pub mode: Mode,
    pub text: String,
    pub tokens: usize,
    pub sources: Vec<String>,
    pub truncated: bool,
}

impl Assembled {
    fn empty(mode: Mode) -> Assembled {
        Assembled { mode, text: String::new(), tokens: 0, sources: vec![], truncated: false }
    }
}

/// The single entry point. `Mode::None` returns before any file access.
pub fn assemble(mode: Mode, root: Option<&Path>, query: &str, b: Budgets) -> Assembled {
    let Some(root) = root.filter(|_| mode != Mode::None) else { return Assembled::empty(mode) };
    if !root.is_dir() {
        return Assembled::empty(mode);
    }
    let (mut text, mut sources, mut truncated) = capsule(root, b.capsule);
    if mode == Mode::Relevant {
        let (rel, rel_sources, rel_cut) = relevant(root, query, b.relevant);
        if !rel.is_empty() {
            text.push_str("\n\n");
            text.push_str(&rel);
        }
        sources.extend(rel_sources);
        truncated |= rel_cut;
    }
    Assembled { mode, tokens: approx_tokens(&text), text, sources, truncated }
}

// ---------------------------------------------------------------- shared file rules

const TEXT_EXT: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "toml", "yaml", "yml", "md", "mdx", "txt", "py", "go", "java", "kt", "cs", "c", "cc", "cpp", "h", "hpp", "css", "scss", "html", "vue",
    "svelte", "sql", "sh", "ps1", "bat", "rb", "php", "swift", "gradle", "xml", "ini", "cfg",
];

fn is_generated(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [".min.js", ".min.css", ".map", ".d.ts", ".snap", ".generated."].iter().any(|s| n.contains(s)) || matches!(n.as_str(), "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "cargo.lock" | "composer.lock")
}

fn readable(name: &str, size: u64) -> bool {
    if size == 0 || size > MAX_FILE_BYTES || is_sensitive_name(name) || is_generated(name) {
        return false;
    }
    name.rsplit_once('.').map(|(_, e)| TEXT_EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

fn read_text(p: &Path) -> Option<String> {
    let bytes = fs::read(p).ok()?;
    if bytes.iter().take(1024).any(|b| *b == 0) {
        return None; // binary
    }
    String::from_utf8(bytes).ok()
}

fn clip(s: &str, max: usize) -> String {
    let t: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        format!("{}…", t.trim_end())
    } else {
        t
    }
}

// ---------------------------------------------------------------- the capsule

const KNOWN_STACK: &[(&str, &str)] = &[
    ("react", "React"), ("vue", "Vue"), ("svelte", "Svelte"), ("next", "Next.js"), ("nuxt", "Nuxt"), ("vite", "Vite"), ("typescript", "TypeScript"),
    ("@tauri-apps/api", "Tauri"), ("electron", "Electron"), ("express", "Express"), ("fastify", "Fastify"), ("nestjs", "NestJS"), ("@nestjs/core", "NestJS"),
    ("pixi.js", "PixiJS"), ("tailwindcss", "Tailwind CSS"), ("prisma", "Prisma"), ("vitest", "Vitest"), ("jest", "Jest"), ("webpack", "webpack"),
    ("angular", "Angular"), ("@angular/core", "Angular"), ("three", "three.js"), ("zustand", "Zustand"), ("redux", "Redux"), ("graphql", "GraphQL"),
];

fn json_of(root: &Path, rel: &str) -> Option<serde_json::Value> {
    serde_json::from_str(&read_text(&root.join(rel))?).ok()
}

/// The `[dependencies]`-style crate names of a Cargo.toml, without versions.
fn cargo_deps(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for l in text.lines() {
        let t = l.trim();
        if t.starts_with('[') {
            inside = t == "[dependencies]" || t == "[build-dependencies]";
            continue;
        }
        if inside {
            if let Some((name, _)) = t.split_once('=') {
                let n = name.trim();
                if !n.is_empty() && !n.starts_with('#') && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                    out.push(n.to_string());
                }
            }
        }
    }
    out
}

fn cargo_field(text: &str, field: &str) -> Option<String> {
    let mut in_pkg = false;
    for l in text.lines() {
        let t = l.trim();
        if t.starts_with('[') {
            in_pkg = t == "[package]";
        } else if in_pkg {
            if let Some((k, v)) = t.split_once('=') {
                if k.trim() == field {
                    return Some(v.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

fn top_level(root: &Path) -> (Vec<String>, Vec<String>) {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let Ok(rd) = fs::read_dir(root) else { return (dirs, files) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if !is_denied_dir(&name) {
                dirs.push(name);
            }
        } else if !is_sensitive_name(&name) && !is_generated(&name) {
            files.push(name);
        }
    }
    dirs.sort();
    files.sort();
    (dirs, files)
}

fn sub_dirs(root: &Path, dir: &str) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(root.join(dir))
        .map(|rd| rd.flatten().filter(|e| e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false)).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !is_denied_dir(n)).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn headings(text: &str, max: usize) -> Vec<String> {
    text.lines().filter(|l| l.starts_with("## ") || l.starts_with("### ")).map(|l| l.trim_start_matches('#').trim().to_string()).filter(|l| !l.is_empty()).take(max).collect()
}

fn first_paragraph(text: &str) -> String {
    let mut para = String::new();
    for l in text.lines() {
        let t = l.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with("![") || t.starts_with('[') || t.starts_with('|') || t.starts_with("```") {
            if !para.is_empty() {
                break;
            }
            continue;
        }
        para.push_str(t);
        para.push(' ');
    }
    para.trim().to_string()
}

const RULE_WORDS: &[&str] = &["must", "never", "always", "prefer", "do not", "don't", "should", "test", "lint", "commit", "format", "convention", "no "];

fn convention_lines(text: &str, max: usize) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| (l.starts_with("- ") || l.starts_with("* ")) && l.len() > 20)
        .filter(|l| {
            let low = l.to_ascii_lowercase();
            RULE_WORDS.iter().any(|w| low.contains(w))
        })
        .map(|l| clip(l.trim_start_matches(['-', '*', ' ']), 140))
        .take(max)
        .collect()
}

/// A compact project summary from a fixed allowlist of metadata files. Returns (text, sources, truncated).
pub fn capsule(root: &Path, budget_tokens: usize) -> (String, Vec<String>, bool) {
    let mut sources: Vec<String> = Vec::new();
    let mut name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "project".into());
    let mut about = String::new();
    let mut stack: Vec<String> = Vec::new();
    let mut scripts: Vec<String> = Vec::new();

    if let Some(pkg) = json_of(root, "package.json") {
        sources.push("package.json".into());
        if let Some(n) = pkg["name"].as_str() {
            name = n.to_string();
        }
        about = pkg["description"].as_str().unwrap_or("").to_string();
        let mut deps: Vec<String> = Vec::new();
        for k in ["dependencies", "devDependencies"] {
            if let Some(o) = pkg[k].as_object() {
                deps.extend(o.keys().cloned());
            }
        }
        for (dep, label) in KNOWN_STACK {
            if deps.iter().any(|d| d == dep) && !stack.iter().any(|s| s == label) {
                stack.push((*label).to_string());
            }
        }
        if stack.is_empty() {
            stack.extend(deps.iter().take(8).cloned());
        }
        if let Some(o) = pkg["scripts"].as_object() {
            scripts.extend(o.iter().take(12).map(|(k, v)| format!("{k}: {}", clip(v.as_str().unwrap_or(""), 70))));
        }
    }
    for rel in ["Cargo.toml", "src-tauri/Cargo.toml"] {
        if let Some(t) = read_text(&root.join(rel)) {
            sources.push(rel.into());
            if let Some(d) = cargo_field(&t, "description") {
                if about.is_empty() {
                    about = d;
                }
            }
            if rel == "Cargo.toml" {
                if let Some(n) = cargo_field(&t, "name") {
                    if name.is_empty() || sources.len() == 1 {
                        name = n;
                    }
                }
            }
            if !stack.iter().any(|s| s == "Rust") {
                stack.push("Rust".into());
            }
            stack.extend(cargo_deps(&t).into_iter().take(10).map(|d| format!("crate {d}")));
        }
    }
    for (rel, label) in [("pyproject.toml", "Python"), ("requirements.txt", "Python"), ("go.mod", "Go"), ("pom.xml", "Java (Maven)"), ("build.gradle", "Java/Kotlin (Gradle)"), ("build.gradle.kts", "Kotlin (Gradle)"), ("composer.json", "PHP"), ("Gemfile", "Ruby")] {
        if root.join(rel).is_file() {
            sources.push(rel.into());
            if !stack.iter().any(|s| s == label) {
                stack.push(label.into());
            }
        }
    }

    let mut out = format!("Project: {name}\n");
    let readme = ["README.md", "readme.md", "README"].iter().find_map(|r| read_text(&root.join(r)).map(|t| (*r, t)));
    if about.is_empty() {
        if let Some((_, t)) = &readme {
            about = first_paragraph(t);
        }
    }
    if let Some((r, _)) = &readme {
        sources.push((*r).to_string());
    }
    if !about.is_empty() {
        out.push_str(&format!("About: {}\n", clip(&about, 320)));
    }
    if !stack.is_empty() {
        stack.dedup();
        out.push_str(&format!("Stack: {}\n", stack.join(", ")));
    }
    if !scripts.is_empty() {
        out.push_str(&format!("Scripts:\n{}\n", scripts.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n")));
    }
    let (dirs, files) = top_level(root);
    if !dirs.is_empty() {
        let mut layout: Vec<String> = Vec::new();
        for d in dirs.iter().take(14) {
            let subs = if matches!(d.as_str(), "src" | "src-tauri" | "app" | "lib" | "packages") { sub_dirs(root, d) } else { vec![] };
            layout.push(if subs.is_empty() { format!("{d}/") } else { format!("{d}/ ({})", subs.iter().take(8).cloned().collect::<Vec<_>>().join(", ")) });
        }
        out.push_str(&format!("Layout: {}\n", layout.join("; ")));
    }
    if !files.is_empty() {
        out.push_str(&format!("Top-level files: {}\n", files.iter().take(12).cloned().collect::<Vec<_>>().join(", ")));
    }
    for rel in ["docs/ARCHITECTURE.md", "ARCHITECTURE.md", "docs/architecture.md"] {
        if let Some(t) = read_text(&root.join(rel)) {
            let h = headings(&t, 10);
            if !h.is_empty() {
                out.push_str(&format!("Architecture notes ({rel}): {}\n", h.join(" | ")));
                sources.push(rel.into());
            }
            break;
        }
    }
    for rel in ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"] {
        if let Some(t) = read_text(&root.join(rel)) {
            let lines = convention_lines(&t, 8);
            if !lines.is_empty() {
                out.push_str(&format!("Conventions ({rel}):\n{}\n", lines.iter().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n")));
                sources.push(rel.into());
            }
            break;
        }
    }
    let limit = budget_tokens * 4;
    let out = redact(out.trim_end());
    let truncated = out.chars().count() > limit;
    let text = if truncated { format!("{} …[capsule truncated]", clip(&out, limit.saturating_sub(24)).trim_end_matches('…')) } else { out };
    sources.dedup();
    (text, sources, truncated)
}

// ---------------------------------------------------------------- relevant excerpts

const STOP: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "into", "have", "what", "where", "when", "how", "why", "does", "can", "could", "would", "should", "about", "there", "their", "which", "please",
    "need", "want", "make", "some", "any", "all", "are", "was", "were", "has", "had", "not", "you", "your", "our", "use", "using", "file", "files", "code", "add", "new", "fix", "get", "set", "let", "its",
    "than", "then", "them", "also", "but", "just", "like", "work", "works", "project", "implement", "change", "update",
];

pub fn keywords(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    // split camelCase / snake_case identifiers too, so `loginHandler` also matches "login"
    let spaced: String = query
        .chars()
        .flat_map(|c| if c.is_uppercase() { vec![' ', c] } else { vec![c] })
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    for w in spaced.split_whitespace() {
        let w = w.to_lowercase();
        if w.chars().count() >= 3 && !STOP.contains(&w.as_str()) && seen.insert(w.clone()) {
            out.push(w);
        }
    }
    out.truncate(12);
    out
}

struct Candidate {
    rel: String,
    abs: PathBuf,
    path_score: usize,
}

fn walk(root: &Path, kws: &[String]) -> Vec<Candidate> {
    let started = Instant::now();
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if started.elapsed() > WALK_BUDGET || seen >= MAX_FILES {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue; // never follow links out of the checkout
            }
            if ft.is_dir() {
                if depth < MAX_DEPTH && !is_denied_dir(&name) && !name.eq_ignore_ascii_case("generated") {
                    stack.push((e.path(), depth + 1));
                }
                continue;
            }
            seen += 1;
            let Ok(md) = e.metadata() else { continue };
            if !readable(&name, md.len()) {
                continue;
            }
            let rel = e.path().strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or(name);
            let low = rel.to_ascii_lowercase();
            let path_score = kws.iter().filter(|k| low.contains(k.as_str())).count() * 6;
            out.push(Candidate { rel, abs: e.path(), path_score });
        }
    }
    out
}

struct Chunk {
    rel: String,
    start: usize,
    end: usize,
    score: usize,
    text: String,
}

fn chunks_of(c: &Candidate, text: &str, kws: &[String]) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    let doc = c.rel.ends_with(".md") || c.rel.ends_with(".mdx");
    let mut out = Vec::new();
    for (i, w) in lines.chunks(CHUNK_LINES).enumerate() {
        let body = w.join("\n");
        let low = body.to_lowercase();
        let hits: usize = kws.iter().map(|k| low.matches(k.as_str()).count().min(4)).sum();
        let score = hits + if hits > 0 && doc { 1 } else { 0 };
        let start = i * CHUNK_LINES + 1;
        out.push(Chunk { rel: c.rel.clone(), start, end: start + w.len() - 1, score, text: body });
    }
    // a file that matched by name but has no matching line still contributes its opening lines
    if out.iter().all(|c| c.score == 0) {
        out.truncate(1);
    } else {
        out.retain(|c| c.score > 0);
    }
    out
}

fn significant(line: &str) -> Option<String> {
    let t = line.trim();
    (t.chars().count() >= 20).then(|| t.to_string())
}

/// Excerpts of the files that best match the request. Returns (text, sources, truncated).
pub fn relevant(root: &Path, query: &str, budget_tokens: usize) -> (String, Vec<String>, bool) {
    let kws = keywords(query);
    if kws.is_empty() {
        return (String::new(), vec![], false);
    }
    let mut cands = walk(root, &kws);
    // files whose path matches are read first; then documentation; then the rest, up to a fixed read budget
    cands.sort_by(|a, b| b.path_score.cmp(&a.path_score).then_with(|| a.rel.ends_with(".md").cmp(&b.rel.ends_with(".md")).reverse()).then_with(|| a.rel.cmp(&b.rel)));
    let mut scored: Vec<(usize, Chunk)> = Vec::new();
    let mut file_scores: Vec<(usize, String)> = Vec::new();
    for c in cands.iter().take(MAX_READ_FILES) {
        let Some(text) = read_text(&c.abs) else { continue };
        let chunks = chunks_of(c, &text, &kws);
        let best = chunks.iter().map(|x| x.score).max().unwrap_or(0);
        if best == 0 && c.path_score == 0 {
            continue;
        }
        file_scores.push((best + c.path_score, c.rel.clone()));
        for ch in chunks {
            scored.push((ch.score + c.path_score, ch));
        }
    }
    file_scores.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let top_files: HashSet<String> = file_scores.iter().take(10).map(|(_, f)| f.clone()).collect();
    scored.retain(|(_, c)| top_files.contains(&c.rel));
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.rel.cmp(&b.1.rel)).then_with(|| a.1.start.cmp(&b.1.start)));

    let limit = budget_tokens * 4;
    let header = "Relevant excerpts (selected locally by keyword match from this repository; they are excerpts, not whole files):";
    let mut used = header.len();
    let mut picked: Vec<(String, usize, usize, String)> = Vec::new();
    let mut have: HashSet<String> = HashSet::new();
    let mut per_file: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut truncated = false;
    for (_, ch) in scored {
        if per_file.get(&ch.rel).copied().unwrap_or(0) >= 2 {
            continue;
        }
        let sig: Vec<String> = ch.text.lines().filter_map(significant).collect();
        if !sig.is_empty() && sig.iter().filter(|l| have.contains(*l)).count() * 10 > sig.len() * 6 {
            continue; // mostly text that is already included
        }
        let body = redact(&ch.text);
        let remaining = limit.saturating_sub(used + ch.rel.len() + 40);
        if remaining < 300 {
            truncated = true;
            break;
        }
        let body = if body.chars().count() > remaining {
            truncated = true;
            clip(&body, remaining)
        } else {
            body
        };
        used += body.len() + ch.rel.len() + 40;
        have.extend(sig);
        *per_file.entry(ch.rel.clone()).or_insert(0) += 1;
        picked.push((ch.rel, ch.start, ch.end, body));
    }
    if picked.is_empty() {
        return (String::new(), vec![], false);
    }
    picked.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut text = String::from(header);
    let mut sources = Vec::new();
    for (rel, s, e, body) in picked {
        text.push_str(&format!("\n\n### {rel} (lines {s}-{e})\n```\n{body}\n```"));
        sources.push(format!("{rel}:{s}-{e}"));
    }
    (text, sources, truncated)
}

// ---------------------------------------------------------------- preferences and preview (commands)

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPrefs {
    pub quest: String,
    pub chat: String,
    pub capsule_budget: usize,
    pub relevant_budget: usize,
}

fn surface_key(surface: &str) -> Option<&'static str> {
    match surface {
        "quest" => Some("ctx_mode_quest"),
        "chat" => Some("ctx_mode_chat"),
        _ => None,
    }
}

/// Last-used mode per surface. Deep Research is never remembered: it starts a Claude Code run, so it must be chosen again each time.
pub fn remembered(db: &Db, surface: &str) -> Mode {
    let m = surface_key(surface).and_then(|k| db.setting(k)).map(|s| Mode::parse(&s)).unwrap_or(Mode::Capsule);
    if m == Mode::Deep {
        Mode::Capsule
    } else {
        m
    }
}

#[tauri::command]
pub fn context_prefs(state: State<'_, AppState>) -> ContextPrefs {
    let b = Budgets::load(&state.db);
    ContextPrefs { quest: remembered(&state.db, "quest").as_str().into(), chat: remembered(&state.db, "chat").as_str().into(), capsule_budget: b.capsule, relevant_budget: b.relevant }
}

#[tauri::command]
pub fn context_budgets_set(state: State<'_, AppState>, capsule: usize, relevant: usize) -> Result<ContextPrefs, String> {
    state.db.set_setting("ctx_budget_capsule", &capsule.clamp(200, 3_000).to_string())?;
    state.db.set_setting("ctx_budget_relevant", &relevant.clamp(500, 12_000).to_string())?;
    Ok(context_prefs(state))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub mode: Mode,
    pub tokens: usize,
    pub sources: Vec<String>,
    pub truncated: bool,
}

/// What a mode would send, before it is sent. `project_id` of None (or an unknown project) previews as empty.
#[tauri::command]
pub async fn context_preview(state: State<'_, AppState>, project_id: Option<i64>, mode: String, query: String) -> Result<Preview, String> {
    let mode = Mode::parse(&mode);
    let root = project_id.and_then(|id| state.db.project(id)).map(|p| PathBuf::from(p.path));
    let budgets = Budgets::load(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        let a = assemble(mode, root.as_deref(), &query, budgets);
        Preview { mode, tokens: a.tokens, sources: a.sources.into_iter().take(14).collect(), truncated: a.truncated }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(PathBuf);
    impl Repo {
        fn new(tag: &str) -> Repo {
            let d = std::env::temp_dir().join(format!("mg-ctx-{tag}-{}", crate::db::now_ms()));
            fs::create_dir_all(&d).unwrap();
            Repo(d)
        }
        fn put(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const SECRET: &str = "sk-live-ABCDEF0123456789ABCDEF0123456789";

    fn sample(tag: &str) -> Repo {
        let r = Repo::new(tag);
        r.put("package.json", r#"{"name":"acme-app","description":"Acme storefront","scripts":{"dev":"vite","build":"tsc && vite build","test":"vitest run"},"dependencies":{"react":"^18","left-pad":"1"},"devDependencies":{"typescript":"^5","vite":"^5"}}"#);
        r.put("README.md", "# Acme\n\nAcme is a small storefront with login and a cart.\n\n## Setup\n");
        r.put("CLAUDE.md", "# Rules\n\n- Always run the tests before you commit anything to the repository\n- Never commit secrets or edit generated files\n- Some unrelated long bullet that says nothing special here\n");
        r.put("docs/ARCHITECTURE.md", "# Arch\n\n## Frontend\n\n## Payments service\n");
        r.put("src/auth/login.ts", &format!("export function loginHandler(user: string, password: string) {{\n  // validates the login credentials and starts a session\n  const api_key = \"{SECRET}\";\n  return startSession(user);\n}}\n"));
        r.put("src/auth/session.ts", "export function startSession(user: string) {\n  // creates a session token for the signed in user\n  return { user };\n}\n");
        r.put("src/cart/cart.ts", "export const cart = [] as string[]; // shopping cart items live here for now\n");
        r.put("src/secrets.ts", "export const dbPassword = 'hunter2hunter2'; // login password\n");
        r.put(".env", "DATABASE_PASSWORD=supersecretvalue login\n");
        r.put(".env.local", "API_KEY=abcdefabcdefabcdef login\n");
        r.put("id_rsa", "-----BEGIN PRIVATE KEY----- login\n");
        r.put("certs/server.pem", "login certificate\n");
        r.put("node_modules/lib/index.js", "// login library code that must never be sent\nmodule.exports = 1;\n");
        r.put("dist/bundle.js", "// login generated bundle\n");
        r.put("package-lock.json", "{\"login\": \"lock file\"}");
        r.put("src/app.min.js", "login minified");
        r.put("assets/logo.png", "login binary\u{0}\u{0}");
        r
    }

    const B: Budgets = Budgets { capsule: DEFAULT_CAPSULE_TOKENS, relevant: DEFAULT_RELEVANT_TOKENS };

    #[test]
    fn no_context_sends_nothing_and_never_touches_the_file_system() {
        let none = assemble(Mode::None, Some(Path::new("Z:/this/path/does/not/exist")), "login please", B);
        assert!(none.text.is_empty() && none.tokens == 0 && none.sources.is_empty());
        let r = sample("none");
        let none = assemble(Mode::None, Some(&r.0), "login", B);
        assert_eq!((none.text.as_str(), none.tokens), ("", 0));
        assert!(assemble(Mode::None, None, "login", B).text.is_empty());
        // without a project even the other modes send nothing
        assert!(assemble(Mode::Capsule, None, "login", B).text.is_empty());
    }

    #[test]
    fn the_capsule_is_a_compact_summary_within_its_budget() {
        let r = sample("capsule");
        let a = assemble(Mode::Capsule, Some(&r.0), "", B);
        assert!(a.text.contains("Project: acme-app") && a.text.contains("React") && a.text.contains("TypeScript") && a.text.contains("Vite"), "{}", a.text);
        assert!(a.text.contains("build: tsc && vite build") && a.text.contains("test: vitest run"), "scripts are listed");
        assert!(a.text.contains("Payments service"), "architecture headings are used");
        assert!(a.text.contains("Always run the tests") && !a.text.contains("unrelated long bullet"), "only rule-like convention lines");
        assert!(a.tokens <= DEFAULT_CAPSULE_TOKENS, "{} tokens", a.tokens);
        assert!(a.text.contains("src/ (auth, cart)"), "layout names sub-folders of src");
        // a tiny budget still holds: it is cut, and says so
        let tiny = assemble(Mode::Capsule, Some(&r.0), "", Budgets { capsule: 200, relevant: 4000 });
        assert!(tiny.tokens <= 215, "{}", tiny.tokens);
        let big = Repo::new("bigcapsule");
        let scripts: String = (0..40).map(|i| format!("\"s{i}\":\"{}\"", "x".repeat(60))).collect::<Vec<_>>().join(",");
        big.put("package.json", &format!("{{\"name\":\"n\",\"scripts\":{{{scripts}}}}}"));
        let cut = capsule(&big.0, 200);
        assert!(approx_tokens(&cut.0) <= 215, "{}", approx_tokens(&cut.0));
    }

    #[test]
    fn the_capsule_never_includes_secrets_or_files_outside_its_allowlist() {
        let r = sample("capsulesecret");
        let a = assemble(Mode::Capsule, Some(&r.0), "", B);
        for bad in [SECRET, "hunter2", "supersecretvalue", "PRIVATE KEY", "abcdefabcdef", ".env", "id_rsa", "server.pem", "node_modules", "package-lock", "app.min.js"] {
            assert!(!a.text.contains(bad), "{bad} leaked: {}", a.text);
        }
    }

    #[test]
    fn relevant_context_retrieves_only_matching_safe_files_within_budget() {
        let r = sample("relevant");
        let a = assemble(Mode::Relevant, Some(&r.0), "How does the login handler start a session?", B);
        assert!(a.text.contains("src/auth/login.ts") && a.text.contains("loginHandler"), "{}", a.text);
        assert!(a.text.contains("src/auth/session.ts"), "{}", a.text);
        assert!(!a.text.contains("src/cart/cart.ts"), "unrelated files are not sent");
        assert!(a.text.contains("Project: acme-app"), "the capsule is included");
        assert!(a.tokens <= DEFAULT_CAPSULE_TOKENS + DEFAULT_RELEVANT_TOKENS, "{} tokens", a.tokens);
        assert!(a.sources.iter().any(|s| s.starts_with("src/auth/login.ts:")));
        // every excluded category stays out even though they all match the keyword "login"
        for bad in [SECRET, "hunter2", "supersecretvalue", "PRIVATE KEY", "abcdefabcdef", "login library code", "generated bundle", "lock file", "minified", "login binary", "certificate", "src/secrets.ts"] {
            assert!(!a.text.contains(bad), "{bad} leaked: {}", a.text);
        }
        assert!(a.text.contains("[REDACTED]"), "secret-looking values inside allowed files are redacted");
    }

    #[test]
    fn relevant_context_respects_a_small_budget_and_does_not_repeat_itself() {
        let r = Repo::new("budget");
        r.put("package.json", r#"{"name":"b"}"#);
        let line = "pub fn process_payment_batch(items: &[Item]) -> Result<Receipt> { payment batch processing logic here }\n";
        r.put("src/payments/a.rs", &line.repeat(300));
        r.put("src/payments/b.rs", &line.repeat(300));
        let small = Budgets { capsule: 1000, relevant: 600 };
        let a = assemble(Mode::Relevant, Some(&r.0), "payment batch processing", small);
        assert!(a.tokens <= 1000 + 600 + 40, "{} tokens", a.tokens);
        assert!(a.truncated || a.text.len() < 600 * 4 + 1200);
        // identical content in two files is included once
        let copies = a.text.matches("process_payment_batch").count();
        assert!(copies <= 41, "{copies}");
        let stats = assemble(Mode::Relevant, Some(&r.0), "zzzz qqqq", small);
        assert!(!stats.text.contains("Relevant excerpts"), "no match, no excerpts");
    }

    #[test]
    fn keyword_extraction_drops_filler_and_splits_identifiers() {
        assert_eq!(keywords("How does the loginHandler work with session_store?"), vec!["login", "handler", "session", "store"]);
        assert!(keywords("please add the new file").is_empty());
        assert!(keywords("ab").is_empty());
    }

    #[test]
    fn links_are_not_followed_out_of_the_checkout() {
        let outside = Repo::new("outside");
        outside.put("leak.ts", "login secret outside of the repository entirely\n");
        let r = sample("link");
        let link = r.0.join("src").join("escape");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside.0, &link).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&outside.0, &link).is_ok();
        let a = assemble(Mode::Relevant, Some(&r.0), "login entirely", B);
        assert!(!a.text.contains("outside of the repository"), "link target must not be read (link created: {made})");
    }

    #[test]
    fn unknown_modes_fall_back_to_the_lightweight_default_and_deep_is_never_remembered() {
        assert_eq!(Mode::parse("deep"), Mode::Deep);
        assert_eq!(Mode::parse("garbage"), Mode::Capsule);
        assert_eq!(Mode::parse(""), Mode::Capsule);
        let db = Db::open_in_memory();
        assert_eq!(remembered(&db, "quest"), Mode::Capsule, "new users start with the capsule");
        db.set_setting("ctx_mode_quest", "none").unwrap();
        assert_eq!(remembered(&db, "quest"), Mode::None, "last-used choice persists");
        db.set_setting("ctx_mode_chat", "relevant").unwrap();
        assert_eq!(remembered(&db, "chat"), Mode::Relevant);
        db.set_setting("ctx_mode_quest", "deep").unwrap();
        assert_eq!(remembered(&db, "quest"), Mode::Capsule, "Deep Research must be chosen again each time");
        assert_eq!(remembered(&db, "uchat"), Mode::Capsule);
        let b = Budgets::load(&db);
        assert_eq!((b.capsule, b.relevant), (1000, 4000));
        db.set_setting("ctx_budget_capsule", "999999").unwrap();
        db.set_setting("ctx_budget_relevant", "5").unwrap();
        let b = Budgets::load(&db);
        assert_eq!((b.capsule, b.relevant), (3000, 500), "budgets are clamped");
    }
}
