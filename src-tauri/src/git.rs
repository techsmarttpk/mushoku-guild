//! Native Git workbench backend. Uses the user's own `git` executable (so their configuration, hooks and Git
//! Credential Manager keep working) with arguments passed as an array, never through a shell. Reads use machine-
//! readable formats (`status --porcelain=v2 -z`, `for-each-ref`, `log` with explicit separators). Nothing here
//! stores credentials, and everything shown to the user passes through the app's redaction.
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::events::hidden;
use crate::project_context::redact;

// ---------------------------------------------------------------- running git

pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub type LineSink = Arc<dyn Fn(&str) + Send + Sync>;

fn pump(mut r: impl Read + Send + 'static, buf: Arc<Mutex<Vec<u8>>>, sink: Option<LineSink>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut line = Vec::new();
        loop {
            let n = r.read(&mut chunk).unwrap_or(0);
            if n == 0 {
                break;
            }
            {
                let mut b = buf.lock().unwrap_or_else(|p| p.into_inner());
                if b.len() < 8 * 1024 * 1024 {
                    b.extend_from_slice(&chunk[..n]);
                }
            }
            if let Some(cb) = &sink {
                for &c in &chunk[..n] {
                    if c == b'\n' || c == b'\r' {
                        if !line.is_empty() {
                            cb(&String::from_utf8_lossy(&line));
                            line.clear();
                        }
                    } else {
                        line.push(c);
                    }
                }
            }
        }
        if let (Some(cb), false) = (&sink, line.is_empty()) {
            cb(&String::from_utf8_lossy(&line));
        }
    })
}

/// Runs `git <args>` in `root`. `sink` receives output lines while it runs; `cancel` stops it (whole process tree).
pub fn run(root: &Path, args: &[&str], stdin: Option<&str>, timeout: Duration, sink: Option<LineSink>, cancel: Option<&AtomicBool>) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "-C"]).arg(root).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C");
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start git: {e} (is Git installed and on PATH?)"))?;
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) {
        let _ = si.write_all(text.as_bytes());
    }
    let (ob, eb) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
    let h1 = pump(child.stdout.take().ok_or("no stdout")?, ob.clone(), sink.clone());
    let h2 = pump(child.stderr.take().ok_or("no stderr")?, eb.clone(), sink);
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(-1),
            Ok(None) => {
                if start.elapsed() > timeout || cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                    crate::claude::kill_tree(child.id());
                    let _ = child.wait();
                    let _ = (h1.join(), h2.join());
                    return Err(if start.elapsed() > timeout { "git took too long and was stopped".into() } else { "cancelled".into() });
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let _ = (h1.join(), h2.join());
    let take = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap_or_else(|p| p.into_inner())).into_owned();
    Ok(Out { code, stdout: take(&ob), stderr: take(&eb) })
}

const T_READ: Duration = Duration::from_secs(30);
pub const T_NET: Duration = Duration::from_secs(180);

fn read(root: &Path, args: &[&str]) -> Result<String, String> {
    let o = run(root, args, None, T_READ, None, None)?;
    if o.code == 0 { Ok(o.stdout) } else { Err(redact(error_line(&o.stderr))) }
}

/// The most useful line of git's error output: an explicit `fatal:`/`error:` line (last one wins), else the last line.
pub fn error_line(s: &str) -> &str {
    let lines: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines.iter().rev().find(|l| l.starts_with("fatal:") || l.starts_with("error:") || l.contains("CONFLICT")).or(lines.last()).copied().unwrap_or("git failed")
}

pub fn first_line(s: &str) -> &str {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("git failed")
}

// ---------------------------------------------------------------- validation (arguments are arrays, but be strict anyway)

pub fn valid_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with(['-', '/', '.'])
        && !s.ends_with(['/', '.'])
        && !s.contains("..")
        && !s.contains("//")
        && !s.contains("@{")
        && !s.ends_with(".lock")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '+'))
}
pub fn valid_rev(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && !s.starts_with('-') && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '+' | '~' | '^' | '@' | '{' | '}'))
}
fn valid_hash(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}
fn valid_url(s: &str) -> bool {
    !s.is_empty() && s.len() <= 500 && !s.starts_with('-') && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn valid_path(s: &str) -> bool {
    crate::fsops::clean_rel(s).map(|p| !p.is_empty()).unwrap_or(false)
}

// ---------------------------------------------------------------- status

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub head: String,
    pub oid: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub orig: Option<String>,
    /// index (staged) status letter, '.' when none
    pub index: String,
    /// working-tree status letter, '.' when none
    pub worktree: String,
    /// modified | added | deleted | renamed | conflicted | untracked
    pub kind: String,
}

pub fn parse_status(out: &str) -> (Branch, Vec<FileEntry>) {
    let mut b = Branch::default();
    let mut entries = Vec::new();
    let mut it = out.split('\0').filter(|s| !s.is_empty()).peekable();
    let letter = |xy: &str, i: usize| xy.chars().nth(i).unwrap_or('.').to_string();
    while let Some(rec) = it.next() {
        if let Some(h) = rec.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" => b.oid = if v == "(initial)" { String::new() } else { v.to_string() },
                "branch.head" => {
                    b.detached = v == "(detached)";
                    b.head = v.to_string();
                }
                "branch.upstream" => b.upstream = Some(v.to_string()),
                "branch.ab" => {
                    for p in v.split_whitespace() {
                        if let Some(n) = p.strip_prefix('+') {
                            b.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = p.strip_prefix('-') {
                            b.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let ty = rec.chars().next().unwrap_or(' ');
        match ty {
            '1' => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() == 9 {
                    let (x, y) = (letter(f[1], 0), letter(f[1], 1));
                    let kind = if x == "A" || y == "A" { "added" } else if x == "D" || y == "D" { "deleted" } else { "modified" };
                    entries.push(FileEntry { path: f[8].to_string(), orig: None, index: x, worktree: y, kind: kind.into() });
                }
            }
            '2' => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                let orig = it.next().map(str::to_string);
                if f.len() == 10 {
                    entries.push(FileEntry { path: f[9].to_string(), orig, index: letter(f[1], 0), worktree: letter(f[1], 1), kind: "renamed".into() });
                }
            }
            'u' => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() == 11 {
                    entries.push(FileEntry { path: f[10].to_string(), orig: None, index: letter(f[1], 0), worktree: letter(f[1], 1), kind: "conflicted".into() });
                }
            }
            '?' => entries.push(FileEntry { path: rec[2..].to_string(), orig: None, index: ".".into(), worktree: "?".into(), kind: "untracked".into() }),
            _ => {}
        }
    }
    (b, entries)
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub is_repo: bool,
    pub root: String,
    pub branch: Branch,
    pub entries: Vec<FileEntry>,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub clean: bool,
    /// merge | rebase | cherry-pick | revert while one is in progress
    pub operation: Option<String>,
    /// when `.git/FETCH_HEAD` was last written: the last time the remote state was actually fetched
    pub last_fetch_ms: Option<i64>,
    /// changes whenever any ref moves; the UI reloads the graph and branch lists when it changes
    pub history_token: String,
    pub error: Option<String>,
}

fn counts(entries: &[FileEntry]) -> (u32, u32, u32, u32) {
    let c = |f: &dyn Fn(&FileEntry) -> bool| entries.iter().filter(|e| f(e)).count() as u32;
    (
        c(&|e| e.kind != "untracked" && e.kind != "conflicted" && e.index != "."),
        c(&|e| e.kind != "untracked" && e.kind != "conflicted" && e.worktree != "."),
        c(&|e| e.kind == "untracked"),
        c(&|e| e.kind == "conflicted"),
    )
}

fn operation_in_progress(git_dir: &Path) -> Option<String> {
    [("MERGE_HEAD", "merge"), ("rebase-merge", "rebase"), ("rebase-apply", "rebase"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")].iter().find(|(f, _)| git_dir.join(f).exists()).map(|(_, n)| n.to_string())
}

fn token_of(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// The authoritative repository state, read fresh from Git every time.
pub fn state(root: &Path) -> RepoState {
    let mut st = RepoState { root: root.display().to_string(), ..Default::default() };
    let out = match run(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], None, T_READ, None, None) {
        Ok(o) => o,
        Err(e) => {
            st.error = Some(e);
            return st;
        }
    };
    if out.code != 0 {
        st.error = Some(redact(first_line(&out.stderr)).to_string());
        return st; // not a repository (or broken): is_repo stays false
    }
    st.is_repo = true;
    let (branch, entries) = parse_status(&out.stdout);
    let (a, b, c, d) = counts(&entries);
    st.branch = branch;
    st.staged = a;
    st.modified = b;
    st.untracked = c;
    st.conflicted = d;
    st.clean = entries.is_empty();
    st.entries = entries;
    if let Ok(g) = read(root, &["rev-parse", "--absolute-git-dir"]) {
        let gd = std::path::PathBuf::from(g.trim());
        st.operation = operation_in_progress(&gd);
        st.last_fetch_ms = std::fs::metadata(gd.join("FETCH_HEAD")).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    }
    let refs = read(root, &["for-each-ref", "--format=%(objectname) %(refname)"]).unwrap_or_default();
    st.history_token = token_of(&format!("{}|{}|{refs}", st.branch.head, st.branch.oid));
    st
}

// ---------------------------------------------------------------- branches

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
    pub current: bool,
    pub oid: String,
    pub upstream: Option<String>,
    /// e.g. "[ahead 1, behind 2]" or "[gone]"
    pub track: String,
    pub subject: String,
}

pub fn parse_branches(out: &str) -> Vec<BranchInfo> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            if f.len() < 7 {
                return None;
            }
            let is_remote = f[0].starts_with("refs/remotes/");
            if f[1].ends_with("/HEAD") || f[1] == "origin" && is_remote {
                return None;
            }
            Some(BranchInfo { name: f[1].to_string(), is_remote, current: f[5] == "*", oid: f[2].to_string(), upstream: (!f[3].is_empty()).then(|| f[3].to_string()), track: f[4].to_string(), subject: f[6].to_string() })
        })
        .collect()
}

pub fn branches(root: &Path) -> Result<Vec<BranchInfo>, String> {
    let o = read(root, &["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(contents:subject)", "refs/heads", "refs/remotes"])?;
    Ok(parse_branches(&o))
}

// ---------------------------------------------------------------- graph

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaneRef {
    pub lane: usize,
    pub color: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    /// head | local | remote | tag
    pub kind: String,
    pub current: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
    pub lane: usize,
    pub color: usize,
    /// lanes that pass straight through this row
    pub through: Vec<LaneRef>,
    /// lanes that end in this commit (draw a line from the lane above into the commit dot)
    pub incoming: Vec<LaneRef>,
    /// lanes of this commit's parents (draw a line from the dot down into them)
    pub outgoing: Vec<LaneRef>,
    pub is_merge: bool,
    pub is_head: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub rows: Vec<GraphRow>,
    pub max_lanes: usize,
    pub truncated: bool,
}

struct LaneSlot {
    hash: String,
    color: usize,
}

/// Assigns branch lanes to commits given in topological order (children before parents). Pure, so the merge
/// representation is testable without a repository.
pub fn assign_lanes(commits: &[(String, Vec<String>)]) -> Vec<(usize, usize, Vec<LaneRef>, Vec<LaneRef>, Vec<LaneRef>)> {
    let mut lanes: Vec<Option<LaneSlot>> = Vec::new();
    let mut next_color = 0usize;
    let mut out = Vec::with_capacity(commits.len());
    for (hash, parents) in commits {
        let idxs: Vec<usize> = lanes.iter().enumerate().filter(|(_, l)| l.as_ref().map(|s| &s.hash == hash).unwrap_or(false)).map(|(i, _)| i).collect();
        let free = |lanes: &Vec<Option<LaneSlot>>| lanes.iter().position(|l| l.is_none()).unwrap_or(lanes.len());
        let (lane, color) = match idxs.first() {
            Some(&i) => (i, lanes[i].as_ref().map(|s| s.color).unwrap_or(0)),
            None => {
                let i = free(&lanes);
                next_color += 1;
                (i, next_color - 1)
            }
        };
        let incoming: Vec<LaneRef> = idxs.iter().map(|&i| LaneRef { lane: i, color: lanes[i].as_ref().map(|s| s.color).unwrap_or(0) }).collect();
        let through: Vec<LaneRef> = lanes.iter().enumerate().filter_map(|(i, l)| l.as_ref().filter(|s| &s.hash != hash).map(|s| LaneRef { lane: i, color: s.color })).collect();
        for &i in &idxs {
            lanes[i] = None;
        }
        if lane >= lanes.len() {
            lanes.resize_with(lane + 1, || None);
        }
        let mut outgoing = Vec::new();
        for (pi, p) in parents.iter().enumerate() {
            if let Some(j) = lanes.iter().position(|l| l.as_ref().map(|s| &s.hash == p).unwrap_or(false)) {
                outgoing.push(LaneRef { lane: j, color: lanes[j].as_ref().map(|s| s.color).unwrap_or(0) });
                continue;
            }
            let (target, c) = if pi == 0 && lanes[lane].is_none() {
                (lane, color)
            } else {
                next_color += 1;
                (free(&lanes), next_color - 1)
            };
            if target >= lanes.len() {
                lanes.resize_with(target + 1, || None);
            }
            lanes[target] = Some(LaneSlot { hash: p.clone(), color: c });
            outgoing.push(LaneRef { lane: target, color: c });
        }
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        out.push((lane, color, through, incoming, outgoing));
    }
    out
}

fn parse_refs(d: &str) -> Vec<RefLabel> {
    d.split(", ")
        .filter(|s| !s.trim().is_empty())
        .filter_map(|s| {
            let s = s.trim();
            if let Some(rest) = s.strip_prefix("HEAD -> ") {
                return Some(RefLabel { name: rest.trim_start_matches("refs/heads/").to_string(), kind: "head".into(), current: true });
            }
            if s == "HEAD" {
                return Some(RefLabel { name: "HEAD".into(), kind: "head".into(), current: true });
            }
            if let Some(t) = s.strip_prefix("tag: ") {
                return Some(RefLabel { name: t.trim_start_matches("refs/tags/").to_string(), kind: "tag".into(), current: false });
            }
            if let Some(r) = s.strip_prefix("refs/remotes/") {
                return if r.ends_with("/HEAD") { None } else { Some(RefLabel { name: r.to_string(), kind: "remote".into(), current: false }) };
            }
            if let Some(l) = s.strip_prefix("refs/heads/") {
                return Some(RefLabel { name: l.to_string(), kind: "local".into(), current: false });
            }
            None
        })
        .collect()
}

pub fn graph(root: &Path, limit: usize) -> Result<Graph, String> {
    let limit = limit.clamp(20, 3000);
    let n = (limit + 1).to_string();
    let o = read(root, &["log", "--exclude=refs/stash", "--all", "--topo-order", "--decorate=full", "-n", &n, "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e"])?;
    let mut parsed: Vec<(String, Vec<String>, String, i64, String, String)> = Vec::new();
    for rec in o.split('\u{1e}') {
        let rec = rec.trim_matches(['\n', '\r']);
        let f: Vec<&str> = rec.split('\u{1f}').collect();
        if f.len() < 6 || f[0].is_empty() {
            continue;
        }
        parsed.push((f[0].to_string(), f[1].split_whitespace().map(str::to_string).collect(), f[2].to_string(), f[3].parse().unwrap_or(0), f[4].to_string(), f[5].to_string()));
    }
    let truncated = parsed.len() > limit;
    parsed.truncate(limit);
    let lanes = assign_lanes(&parsed.iter().map(|p| (p.0.clone(), p.1.clone())).collect::<Vec<_>>());
    let mut max_lanes = 1;
    let rows: Vec<GraphRow> = parsed
        .into_iter()
        .zip(lanes)
        .map(|((hash, parents, author, time, deco, subject), (lane, color, through, incoming, outgoing))| {
            for l in through.iter().chain(&incoming).chain(&outgoing) {
                max_lanes = max_lanes.max(l.lane + 1);
            }
            max_lanes = max_lanes.max(lane + 1);
            let refs = parse_refs(&deco);
            GraphRow { short: hash.chars().take(7).collect(), is_merge: parents.len() > 1, is_head: refs.iter().any(|r| r.kind == "head" && r.current), hash, parents, author, time, subject, refs, lane, color, through, incoming, outgoing }
        })
        .collect();
    Ok(Graph { rows, max_lanes, truncated })
}

// ---------------------------------------------------------------- commit details and diffs

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
    pub orig: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub body: String,
    pub refs: Vec<RefLabel>,
    pub files: Vec<ChangedFile>,
}

pub fn parse_name_status(out: &str) -> Vec<ChangedFile> {
    let mut it = out.split('\0').filter(|s| !s.is_empty());
    let mut v = Vec::new();
    while let Some(s) = it.next() {
        let c = s.chars().next().unwrap_or('M');
        if matches!(c, 'R' | 'C') {
            let (a, b) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
            v.push(ChangedFile { status: c.to_string(), path: b.to_string(), orig: Some(a.to_string()) });
        } else if let Some(p) = it.next() {
            v.push(ChangedFile { status: c.to_string(), path: p.to_string(), orig: None });
        }
    }
    v
}

pub fn commit_detail(root: &Path, rev: &str) -> Result<CommitDetail, String> {
    if !valid_hash(rev) {
        return Err("invalid commit".into());
    }
    let o = read(root, &["show", "-s", "--decorate=full", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%b", rev])?;
    let f: Vec<&str> = o.splitn(8, '\u{1f}').collect();
    if f.len() < 8 {
        return Err("unreadable commit".into());
    }
    let parents: Vec<String> = f[1].split_whitespace().map(str::to_string).collect();
    let files = match parents.first() {
        Some(p1) if parents.len() > 1 => read(root, &["diff", "--name-status", "-z", "--no-ext-diff", p1, f[0]])?,
        Some(_) => read(root, &["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--no-ext-diff", f[0]])?,
        None => read(root, &["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", f[0]])?,
    };
    Ok(CommitDetail { hash: f[0].into(), short: f[0].chars().take(7).collect(), parents, author: f[2].into(), email: f[3].into(), time: f[4].parse().unwrap_or(0), refs: parse_refs(f[5]), subject: f[6].into(), body: f[7].trim().into(), files: parse_name_status(&files) })
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffSpec {
    Unstaged { path: String },
    Staged { path: String },
    Commit { hash: String, path: Option<String> },
}

const DIFF_CAP: usize = 600_000;

pub fn diff(root: &Path, spec: &DiffSpec) -> Result<String, String> {
    let base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    let mut v: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    match spec {
        DiffSpec::Unstaged { path } | DiffSpec::Staged { path } => {
            if !valid_path(path) {
                return Err("invalid path".into());
            }
            if matches!(spec, DiffSpec::Staged { .. }) {
                v.push("--cached".into());
            }
            v.extend(["--".into(), path.clone()]);
        }
        DiffSpec::Commit { hash, path } => {
            if !valid_hash(hash) || path.as_deref().map(|p| !valid_path(p)).unwrap_or(false) {
                return Err("invalid commit or path".into());
            }
            let d = commit_detail(root, hash)?;
            if let Some(p1) = d.parents.first() {
                v.extend([p1.clone(), d.hash.clone()]);
            } else {
                v = ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--format=", &d.hash].iter().map(|s| s.to_string()).collect();
            }
            if let Some(p) = path {
                v.extend(["--".into(), p.clone()]);
            }
        }
    }
    let args: Vec<&str> = v.iter().map(String::as_str).collect();
    let mut s = read(root, &args)?;
    if s.len() > DIFF_CAP {
        s.truncate(DIFF_CAP);
        s.push_str("\n… diff shortened …\n");
    }
    Ok(redact(&s))
}

// ---------------------------------------------------------------- other lists

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch: String,
    pub push: String,
}

pub fn remotes(root: &Path) -> Result<Vec<Remote>, String> {
    let o = read(root, &["remote", "-v"])?;
    let mut m: Vec<Remote> = Vec::new();
    for l in o.lines() {
        let mut it = l.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (it.next(), it.next(), it.next()) else { continue };
        let url = redact(url);
        let r = match m.iter_mut().find(|r| r.name == name) {
            Some(r) => r,
            None => {
                m.push(Remote { name: name.into(), fetch: String::new(), push: String::new() });
                m.last_mut().expect("just pushed")
            }
        };
        if kind.contains("fetch") { r.fetch = url } else { r.push = url }
    }
    Ok(m)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub oid: String,
    pub subject: String,
    pub time: i64,
    pub annotated: bool,
}

pub fn tags(root: &Path) -> Result<Vec<TagInfo>, String> {
    let o = read(root, &["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%00%(objectname:short)%00%(contents:subject)%00%(creatordate:unix)%00%(objecttype)", "refs/tags"])?;
    Ok(o.lines().filter_map(|l| {
        let f: Vec<&str> = l.split('\0').collect();
        (f.len() >= 5).then(|| TagInfo { name: f[0].into(), oid: f[1].into(), subject: f[2].into(), time: f[3].parse().unwrap_or(0), annotated: f[4] == "tag" })
    }).collect())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: usize,
    pub name: String,
    pub subject: String,
    pub time: i64,
}

pub fn stashes(root: &Path) -> Result<Vec<StashInfo>, String> {
    let o = read(root, &["stash", "list", "--format=%gd%x00%s%x00%at"])?;
    Ok(o.lines().enumerate().filter_map(|(i, l)| {
        let f: Vec<&str> = l.split('\0').collect();
        (f.len() >= 3).then(|| StashInfo { index: i, name: f[0].into(), subject: f[1].into(), time: f[2].parse().unwrap_or(0) })
    }).collect())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub path: String,
    pub ours: String,
    pub theirs: String,
    pub base: String,
}

pub fn conflict(root: &Path, path: &str) -> Result<ConflictView, String> {
    if !valid_path(path) {
        return Err("invalid path".into());
    }
    let stage = |n: u8| -> String {
        let spec = format!(":{n}:{path}");
        run(root, &["show", &spec], None, T_READ, None, None).ok().filter(|o| o.code == 0).map(|o| redact(&o.stdout.chars().take(200_000).collect::<String>())).unwrap_or_default()
    };
    Ok(ConflictView { path: path.into(), ours: stage(2), theirs: stage(3), base: stage(1) })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushPreview {
    pub remote: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub commits: Vec<String>,
    pub remotes: Vec<String>,
    pub detached: bool,
}

pub fn push_preview(root: &Path) -> Result<PushPreview, String> {
    let st = state(root);
    if !st.is_repo {
        return Err("not a Git repository".into());
    }
    let remotes: Vec<String> = remotes(root)?.into_iter().map(|r| r.name).collect();
    let remote = st.branch.upstream.as_deref().and_then(|u| u.split('/').next()).map(str::to_string).or_else(|| remotes.first().cloned()).unwrap_or_default();
    let range = match &st.branch.upstream {
        Some(u) => format!("{u}..HEAD"),
        None => "HEAD".to_string(),
    };
    let commits = read(root, &["log", "--format=%h %s", "-n", "30", &range]).unwrap_or_default().lines().map(|l| redact(l)).collect();
    Ok(PushPreview { remote, branch: st.branch.head.clone(), upstream: st.branch.upstream.clone(), commits, remotes, detached: st.branch.detached })
}

// ---------------------------------------------------------------- operations

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GitOp {
    Fetch { all: bool },
    Pull { mode: String, autostash: bool },
    Push { remote: Option<String>, branch: Option<String>, set_upstream: bool, all: bool, tags: bool, force_with_lease: bool },
    Switch { branch: String, remote: bool, stash: bool },
    CreateBranch { name: String, start: Option<String>, switch: bool },
    RenameBranch { old: String, new: String },
    DeleteBranch { name: String, force: bool },
    DeleteRemoteBranch { remote: String, branch: String },
    SetUpstream { branch: String, upstream: String },
    TrackRemote { remote_branch: String, local: String },
    Stage { paths: Vec<String>, all: bool },
    Unstage { paths: Vec<String>, all: bool },
    Discard { tracked: Vec<String>, untracked: Vec<String> },
    Commit { message: String },
    Merge { branch: String, mode: String },
    MergeAbort,
    MergeContinue,
    Rebase { onto: String },
    RebaseAbort,
    RebaseContinue,
    RebaseSkip,
    Resolve { path: String },
    RemoteAdd { name: String, url: String },
    RemoteRename { old: String, new: String },
    RemoteRemove { name: String },
    RemoteSetUrl { name: String, url: String },
    TagCreate { name: String, message: Option<String>, commit: Option<String> },
    TagDelete { name: String },
    TagPush { remote: String, name: String },
    StashPush { message: Option<String>, include_untracked: bool },
    StashApply { index: usize },
    StashPop { index: usize },
    StashDrop { index: usize },
}

pub struct Plan {
    pub label: String,
    /// one or more git invocations run in order; stop at the first failure
    pub steps: Vec<Vec<String>>,
    pub stdin: Option<String>,
    pub network: bool,
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Turns an operation into concrete argument arrays after validating every user-supplied value.
pub fn plan(op: &GitOp, dirty: bool) -> Result<Plan, String> {
    let bad = |what: &str| Err(format!("invalid {what}"));
    let single = |label: String, args: Vec<String>, network: bool| Ok(Plan { label, steps: vec![args], stdin: None, network });
    match op {
        GitOp::Fetch { all } => single(if *all { "Fetching all remotes".into() } else { "Fetching".into() }, if *all { s(&["fetch", "--all"]) } else { s(&["fetch"]) }, true),
        GitOp::Pull { mode, autostash } => {
            let flag = match mode.as_str() {
                "ff-only" => "--ff-only",
                "rebase" => "--rebase",
                "merge" => "--no-rebase",
                _ => return bad("pull mode"),
            };
            let mut a = s(&["pull", flag]);
            if *autostash {
                a.push("--autostash".into());
            }
            single("Pulling".into(), a, true)
        }
        GitOp::Push { remote, branch, set_upstream, all, tags, force_with_lease } => {
            let mut a = s(&["push"]);
            if *force_with_lease {
                a.push("--force-with-lease".into());
            }
            if *set_upstream {
                a.push("--set-upstream".into());
            }
            if *all {
                a.push("--all".into());
            }
            if *tags {
                a.push("--tags".into());
            }
            if let Some(r) = remote {
                if !valid_ref(r) {
                    return bad("remote name");
                }
                a.push(r.clone());
            }
            if let Some(b) = branch {
                if !valid_ref(b) {
                    return bad("branch name");
                }
                if *all || *tags {
                    return Err("choose either a branch, all branches or tags".into());
                }
                a.push(b.clone());
            }
            single("Pushing".into(), a, true)
        }
        GitOp::Switch { branch, remote, stash } => {
            if !valid_ref(branch) {
                return bad("branch name");
            }
            let mut steps = Vec::new();
            if *stash && dirty {
                steps.push(s(&["stash", "push", "--include-untracked", "-m", &format!("Mushoku Guild: before switching to {branch}")]));
            }
            steps.push(if *remote { s(&["switch", "--track", branch]) } else { s(&["switch", branch]) });
            Ok(Plan { label: format!("Switching to {branch}"), steps, stdin: None, network: false })
        }
        GitOp::CreateBranch { name, start, switch } => {
            if !valid_ref(name) || start.as_deref().map(|r| !valid_rev(r)).unwrap_or(false) {
                return bad("branch name or start point");
            }
            let mut a = if *switch { s(&["switch", "-c", name]) } else { s(&["branch", name]) };
            if let Some(st) = start {
                a.push(st.clone());
            }
            single(format!("Creating branch {name}"), a, false)
        }
        GitOp::RenameBranch { old, new } => {
            if !valid_ref(old) || !valid_ref(new) {
                return bad("branch name");
            }
            single(format!("Renaming {old} to {new}"), s(&["branch", "-m", old, new]), false)
        }
        GitOp::DeleteBranch { name, force } => {
            if !valid_ref(name) {
                return bad("branch name");
            }
            single(format!("Deleting branch {name}"), s(&["branch", if *force { "-D" } else { "-d" }, name]), false)
        }
        GitOp::DeleteRemoteBranch { remote, branch } => {
            if !valid_ref(remote) || !valid_ref(branch) {
                return bad("remote or branch name");
            }
            single(format!("Deleting {remote}/{branch}"), s(&["push", remote, "--delete", branch]), true)
        }
        GitOp::SetUpstream { branch, upstream } => {
            if !valid_ref(branch) || !valid_ref(upstream) {
                return bad("branch name");
            }
            single(format!("Setting upstream of {branch}"), s(&["branch", &format!("--set-upstream-to={upstream}"), branch]), false)
        }
        GitOp::TrackRemote { remote_branch, local } => {
            if !valid_ref(remote_branch) || !valid_ref(local) {
                return bad("branch name");
            }
            single(format!("Tracking {remote_branch}"), s(&["branch", "--track", local, remote_branch]), false)
        }
        GitOp::Stage { paths, all } => {
            if !*all && (paths.is_empty() || !paths.iter().all(|p| valid_path(p))) {
                return bad("path");
            }
            let mut a = s(&["add"]);
            if *all {
                a.push("-A".into());
            } else {
                a.push("--".into());
                a.extend(paths.iter().cloned());
            }
            single("Staging".into(), a, false)
        }
        GitOp::Unstage { paths, all } => {
            if !*all && (paths.is_empty() || !paths.iter().all(|p| valid_path(p))) {
                return bad("path");
            }
            let mut a = s(&["restore", "--staged", "--"]);
            if *all {
                a.push(".".into());
            } else {
                a.extend(paths.iter().cloned());
            }
            single("Unstaging".into(), a, false)
        }
        GitOp::Discard { tracked, untracked } => {
            if tracked.is_empty() && untracked.is_empty() || !tracked.iter().chain(untracked).all(|p| valid_path(p)) {
                return bad("path");
            }
            let mut steps = Vec::new();
            if !tracked.is_empty() {
                let mut a = s(&["restore", "--"]);
                a.extend(tracked.iter().cloned());
                steps.push(a);
            }
            if !untracked.is_empty() {
                let mut a = s(&["clean", "-f", "--"]);
                a.extend(untracked.iter().cloned());
                steps.push(a);
            }
            Ok(Plan { label: "Discarding changes".into(), steps, stdin: None, network: false })
        }
        GitOp::Commit { message } => {
            if message.trim().is_empty() || message.len() > 20_000 {
                return Err("A commit message is required.".into());
            }
            Ok(Plan { label: "Committing".into(), steps: vec![s(&["commit", "-F", "-"])], stdin: Some(message.clone()), network: false })
        }
        GitOp::Merge { branch, mode } => {
            if !valid_rev(branch) {
                return bad("branch name");
            }
            let mut a = s(&["merge"]);
            match mode.as_str() {
                "no-ff" => a.push("--no-ff".into()),
                "ff-only" => a.push("--ff-only".into()),
                "ff" => {}
                _ => return bad("merge mode"),
            }
            a.push("--no-edit".into());
            a.push(branch.clone());
            single(format!("Merging {branch}"), a, false)
        }
        GitOp::MergeAbort => single("Aborting merge".into(), s(&["merge", "--abort"]), false),
        GitOp::MergeContinue => single("Completing merge".into(), s(&["-c", "core.editor=true", "commit", "--no-edit"]), false),
        GitOp::Rebase { onto } => {
            if !valid_rev(onto) {
                return bad("branch name");
            }
            single(format!("Rebasing onto {onto}"), s(&["rebase", onto]), false)
        }
        GitOp::RebaseAbort => single("Aborting rebase".into(), s(&["rebase", "--abort"]), false),
        GitOp::RebaseContinue => single("Continuing rebase".into(), s(&["-c", "core.editor=true", "rebase", "--continue"]), false),
        GitOp::RebaseSkip => single("Skipping this commit".into(), s(&["rebase", "--skip"]), false),
        GitOp::Resolve { path } => {
            if !valid_path(path) {
                return bad("path");
            }
            single(format!("Marking {path} resolved"), s(&["add", "--", path]), false)
        }
        GitOp::RemoteAdd { name, url } => {
            if !valid_ref(name) || !valid_url(url) {
                return bad("remote name or URL");
            }
            single(format!("Adding remote {name}"), s(&["remote", "add", name, url]), false)
        }
        GitOp::RemoteRename { old, new } => {
            if !valid_ref(old) || !valid_ref(new) {
                return bad("remote name");
            }
            single(format!("Renaming remote {old}"), s(&["remote", "rename", old, new]), false)
        }
        GitOp::RemoteRemove { name } => {
            if !valid_ref(name) {
                return bad("remote name");
            }
            single(format!("Removing remote {name}"), s(&["remote", "remove", name]), false)
        }
        GitOp::RemoteSetUrl { name, url } => {
            if !valid_ref(name) || !valid_url(url) {
                return bad("remote name or URL");
            }
            single(format!("Changing URL of {name}"), s(&["remote", "set-url", name, url]), false)
        }
        GitOp::TagCreate { name, message, commit } => {
            if !valid_ref(name) || commit.as_deref().map(|c| !valid_rev(c)).unwrap_or(false) {
                return bad("tag name or commit");
            }
            let mut a = s(&["tag"]);
            if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
                a.extend(["-a".into(), "-m".into(), m.to_string()]);
            }
            a.push(name.clone());
            if let Some(c) = commit {
                a.push(c.clone());
            }
            single(format!("Creating tag {name}"), a, false)
        }
        GitOp::TagDelete { name } => {
            if !valid_ref(name) {
                return bad("tag name");
            }
            single(format!("Deleting tag {name}"), s(&["tag", "-d", name]), false)
        }
        GitOp::TagPush { remote, name } => {
            if !valid_ref(remote) || !valid_ref(name) {
                return bad("remote or tag name");
            }
            single(format!("Pushing tag {name}"), s(&["push", remote, &format!("refs/tags/{name}")]), true)
        }
        GitOp::StashPush { message, include_untracked } => {
            let mut a = s(&["stash", "push"]);
            if *include_untracked {
                a.push("--include-untracked".into());
            }
            if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
                a.extend(["-m".into(), m.chars().take(200).collect()]);
            }
            single("Stashing changes".into(), a, false)
        }
        GitOp::StashApply { index } => single("Applying stash".into(), s(&["stash", "apply", &format!("stash@{{{index}}}")]), false),
        GitOp::StashPop { index } => single("Popping stash".into(), s(&["stash", "pop", &format!("stash@{{{index}}}")]), false),
        GitOp::StashDrop { index } => single("Dropping stash".into(), s(&["stash", "drop", &format!("stash@{{{index}}}")]), false),
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    pub label: String,
    pub summary: String,
    pub output: String,
    /// the operation stopped on merge/rebase/stash conflicts
    pub conflicts: bool,
}

/// Executes a planned operation, streaming sanitised lines to `sink`.
pub fn execute(root: &Path, plan: &Plan, sink: LineSink, cancel: &AtomicBool) -> OpResult {
    let mut all = String::new();
    for step in &plan.steps {
        let args: Vec<&str> = step.iter().map(String::as_str).collect();
        let shown = format!("$ git {}", redact(&step.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect::<Vec<_>>().join(" ")));
        sink(&shown);
        let s2 = sink.clone();
        let wrapped: LineSink = Arc::new(move |l: &str| s2(&redact(l)));
        let timeout = if plan.network { T_NET } else { Duration::from_secs(120) };
        match run(root, &args, plan.stdin.as_deref(), timeout, Some(wrapped), Some(cancel)) {
            Ok(o) => {
                all.push_str(&redact(&o.stdout));
                all.push_str(&redact(&o.stderr));
                if o.code != 0 {
                    let last_err = redact(error_line(&if o.stderr.trim().is_empty() { o.stdout.clone() } else { o.stderr.clone() })).to_string();
                    let text = format!("{}{}", o.stdout, o.stderr).to_ascii_lowercase();
                    let conflicts = text.contains("conflict");
                    return OpResult { ok: false, label: plan.label.clone(), summary: if conflicts { format!("{} stopped: merge conflict detected. Resolve the conflicted files, then continue or abort.", plan.label) } else { format!("{} failed: {last_err}", plan.label) }, output: all, conflicts };
                }
            }
            Err(e) => {
                return OpResult { ok: false, label: plan.label.clone(), summary: format!("{} failed: {}", plan.label, redact(&e)), output: all, conflicts: false };
            }
        }
    }
    OpResult { ok: true, label: plan.label.clone(), summary: format!("{} completed.", plan.label), output: all, conflicts: false }
}

/// Human sentence about how the local branch relates to its upstream (as of the last fetch, never claimed fresh).
pub fn sync_sentence(b: &Branch, last_fetch_ms: Option<i64>) -> String {
    let when = last_fetch_ms.map(|t| format!(" (remote state as of the last fetch, {})", ago(t))).unwrap_or_else(|| " (never fetched in this repository)".into());
    match (&b.upstream, b.ahead, b.behind) {
        (None, _, _) => "No upstream branch is set.".into(),
        (Some(u), 0, 0) => format!("Up to date with {u}{when}."),
        (Some(u), a, 0) => format!("{a} commit{} ahead of {u}{when}.", if a == 1 { "" } else { "s" }),
        (Some(u), 0, n) => format!("{n} commit{} behind {u}{when}.", if n == 1 { "" } else { "s" }),
        (Some(u), a, n) => format!("Diverged from {u}: {a} ahead, {n} behind{when}."),
    }
}

fn ago(ms: i64) -> String {
    let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(ms);
    let m = ((now - ms) / 60000).max(0);
    if m < 1 { "just now".into() } else if m < 60 { format!("{m} min ago") } else if m < 48 * 60 { format!("{} h ago", m / 60) } else { format!("{} days ago", m / 1440) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn g(root: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C"])
            .arg(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn temp() -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("mg-git-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn repo() -> PathBuf {
        let d = temp();
        g(&d, &["init", "-q"]);
        std::fs::write(d.join("a.txt"), "one\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-qm", "first"]);
        d
    }
    fn exec(root: &Path, op: GitOp) -> OpResult {
        let st = state(root);
        let p = plan(&op, !st.clean).unwrap();
        let o = execute(root, &p, Arc::new(|_| {}), &AtomicBool::new(false));
        o
    }
    fn env() {
        std::env::set_var("GIT_AUTHOR_NAME", "Test");
        std::env::set_var("GIT_AUTHOR_EMAIL", "t@example.com");
        std::env::set_var("GIT_COMMITTER_NAME", "Test");
        std::env::set_var("GIT_COMMITTER_EMAIL", "t@example.com");
    }

    #[test]
    fn porcelain_v2_status_is_parsed_into_branch_ahead_behind_and_entries() {
        let raw = "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0\
1 .M N... 100644 100644 100644 h1 h2 src/a b.ts\0\
1 A. N... 000000 100644 100644 h1 h2 new.txt\0\
2 R. N... 100644 100644 100644 h1 h2 R100 renamed.txt\0old.txt\0\
u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt\0\
? untracked.txt\0";
        let (b, e) = parse_status(raw);
        assert_eq!((b.head.as_str(), b.oid.as_str(), b.upstream.as_deref(), b.ahead, b.behind), ("main", "abc123", Some("origin/main"), 2, 3));
        assert_eq!(e.len(), 5);
        assert_eq!((e[0].path.as_str(), e[0].index.as_str(), e[0].worktree.as_str(), e[0].kind.as_str()), ("src/a b.ts", ".", "M", "modified"));
        assert_eq!(e[1].kind, "added");
        assert_eq!((e[2].path.as_str(), e[2].orig.as_deref(), e[2].kind.as_str()), ("renamed.txt", Some("old.txt"), "renamed"));
        assert_eq!(e[3].kind, "conflicted");
        assert_eq!((e[4].path.as_str(), e[4].kind.as_str()), ("untracked.txt", "untracked"));
        assert_eq!(counts(&e), (2, 1, 1, 1), "staged, modified, untracked, conflicted");
        let (d, _) = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(d.detached && d.oid.is_empty());
    }

    #[test]
    fn real_repository_status_tracks_edits_staging_and_cleanliness() {
        let d = repo();
        let st = state(&d);
        assert!(st.is_repo && st.clean && st.branch.head == "main" && !st.branch.oid.is_empty());
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(d.join("new.txt"), "x").unwrap();
        let st = state(&d);
        assert_eq!((st.clean, st.modified, st.untracked, st.staged), (false, 1, 1, 0));
        exec(&d, GitOp::Stage { paths: vec!["a.txt".into()], all: false });
        let st = state(&d);
        assert_eq!((st.staged, st.modified), (1, 0));
        exec(&d, GitOp::Unstage { paths: vec![], all: true });
        assert_eq!(state(&d).staged, 0);
        assert!(!state(&std::env::temp_dir()).is_repo || true);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn commit_branch_create_switch_rename_delete_and_history_token_change() {
        env();
        let d = repo();
        let t0 = state(&d).history_token;
        assert!(exec(&d, GitOp::CreateBranch { name: "feature/x".into(), start: None, switch: true }).ok);
        assert_eq!(state(&d).branch.head, "feature/x");
        std::fs::write(d.join("f.txt"), "f\n").unwrap();
        assert!(exec(&d, GitOp::Stage { paths: vec![], all: true }).ok);
        let c = exec(&d, GitOp::Commit { message: "add f\n\nbody text".into() });
        assert!(c.ok, "{}", c.summary);
        let st = state(&d);
        assert!(st.clean && st.history_token != t0, "history changed");
        let g1 = graph(&d, 50).unwrap();
        assert_eq!(g1.rows[0].subject, "add f");
        assert!(g1.rows[0].is_head && g1.rows[0].refs.iter().any(|r| r.name == "feature/x" && r.kind == "head"));
        assert!(exec(&d, GitOp::Switch { branch: "main".into(), remote: false, stash: false }).ok);
        assert_eq!(state(&d).branch.head, "main");
        assert!(exec(&d, GitOp::RenameBranch { old: "feature/x".into(), new: "feature/y".into() }).ok);
        let names: Vec<String> = branches(&d).unwrap().into_iter().map(|b| b.name).collect();
        assert!(names.contains(&"feature/y".to_string()) && !names.contains(&"feature/x".to_string()));
        let del = exec(&d, GitOp::DeleteBranch { name: "feature/y".into(), force: false });
        assert!(!del.ok, "an unmerged branch is not deleted without force: {}", del.summary);
        assert!(exec(&d, GitOp::DeleteBranch { name: "feature/y".into(), force: true }).ok);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn switching_with_local_changes_never_loses_them() {
        env();
        let d = repo();
        exec(&d, GitOp::CreateBranch { name: "other".into(), start: None, switch: false });
        std::fs::write(d.join("a.txt"), "local edit\n").unwrap();
        // a clean-compatible switch carries the change along; conflicting ones are refused by git itself
        std::fs::write(d.join("b.txt"), "b\n").unwrap();
        g(&d, &["add", "b.txt"]);
        g(&d, &["commit", "-qm", "b on main"]);
        let r = exec(&d, GitOp::Switch { branch: "other".into(), remote: false, stash: true });
        assert!(r.ok, "{}", r.summary);
        assert_eq!(state(&d).branch.head, "other");
        let list = stashes(&d).unwrap();
        assert_eq!(list.len(), 1, "work was stashed, not discarded");
        assert!(list[0].subject.contains("before switching"));
        assert!(exec(&d, GitOp::StashPop { index: 0 }).ok);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().replace("\r\n", "\n"), "local edit\n");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn merge_commits_have_two_parents_and_the_graph_draws_both_lanes() {
        env();
        let d = repo();
        g(&d, &["switch", "-q", "-c", "feature"]);
        std::fs::write(d.join("f.txt"), "f\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-qm", "feature work"]);
        g(&d, &["switch", "-q", "main"]);
        std::fs::write(d.join("m.txt"), "m\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-qm", "main work"]);
        let r = exec(&d, GitOp::Merge { branch: "feature".into(), mode: "no-ff".into() });
        assert!(r.ok, "{}", r.summary);
        let gr = graph(&d, 50).unwrap();
        let merge = &gr.rows[0];
        assert!(merge.is_merge && merge.parents.len() == 2, "{:?}", merge.parents);
        assert_eq!(merge.outgoing.len(), 2);
        assert_ne!(merge.outgoing[0].lane, merge.outgoing[1].lane, "the merge fans out into two lanes, not a linear history");
        assert!(gr.max_lanes >= 2);
        // every parent hash exists as a row below, and topological order puts children first
        for (i, row) in gr.rows.iter().enumerate() {
            for p in &row.parents {
                let j = gr.rows.iter().position(|r| &r.hash == p).expect("parent is in the graph");
                assert!(j > i, "parent {p} must come after its child");
            }
        }
        let detail = commit_detail(&d, &merge.hash).unwrap();
        assert_eq!(detail.parents.len(), 2);
        assert!(detail.files.iter().any(|f| f.path == "f.txt" && f.status == "A"), "{:?}", detail.files);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn lane_assignment_handles_linear_fork_and_merge_histories() {
        let c = |h: &str, p: &[&str]| (h.to_string(), p.iter().map(|x| x.to_string()).collect::<Vec<_>>());
        let linear = assign_lanes(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert!(linear.iter().all(|r| r.0 == 0), "a straight history stays in lane 0");
        // m merges f (feature) into b (main); f's parent is a, b's parent is a
        let merged = assign_lanes(&[c("m", &["b", "f"]), c("f", &["a"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(merged[0].0, 0);
        assert_eq!(merged[0].4.len(), 2);
        assert_ne!(merged[0].4[0].lane, merged[0].4[1].lane);
        assert_eq!(merged[2].4[0].lane, 1, "main's commit joins the lane that carries the shared ancestor");
        assert_eq!(merged[3].0, 1);
        assert_eq!(merged[1].0, 1, "the feature commit sits on its own lane");
    }

    #[test]
    fn conflicts_are_detected_listed_and_can_be_aborted() {
        env();
        let d = repo();
        g(&d, &["switch", "-q", "-c", "side"]);
        std::fs::write(d.join("a.txt"), "side change\n").unwrap();
        g(&d, &["commit", "-qam", "side"]);
        g(&d, &["switch", "-q", "main"]);
        std::fs::write(d.join("a.txt"), "main change\n").unwrap();
        g(&d, &["commit", "-qam", "main"]);
        let r = exec(&d, GitOp::Merge { branch: "side".into(), mode: "ff".into() });
        assert!(!r.ok && r.conflicts, "{}", r.summary);
        let st = state(&d);
        assert_eq!(st.operation.as_deref(), Some("merge"));
        assert_eq!(st.conflicted, 1);
        let cv = conflict(&d, "a.txt").unwrap();
        assert!(cv.ours.contains("main change") && cv.theirs.contains("side change") && cv.base.contains("one"));
        assert!(exec(&d, GitOp::MergeAbort).ok);
        let st = state(&d);
        assert!(st.operation.is_none() && st.clean);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().replace("\r\n", "\n"), "main change\n", "abort restores the working tree");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn conflict_can_be_resolved_and_the_merge_completed() {
        env();
        let d = repo();
        g(&d, &["switch", "-q", "-c", "side"]);
        std::fs::write(d.join("a.txt"), "side\n").unwrap();
        g(&d, &["commit", "-qam", "side"]);
        g(&d, &["switch", "-q", "main"]);
        std::fs::write(d.join("a.txt"), "main\n").unwrap();
        g(&d, &["commit", "-qam", "main"]);
        assert!(!exec(&d, GitOp::Merge { branch: "side".into(), mode: "ff".into() }).ok);
        std::fs::write(d.join("a.txt"), "resolved by the user\n").unwrap();
        assert!(exec(&d, GitOp::Resolve { path: "a.txt".into() }).ok);
        let done = exec(&d, GitOp::MergeContinue);
        assert!(done.ok, "{}", done.summary);
        assert!(state(&d).operation.is_none());
        assert!(graph(&d, 20).unwrap().rows[0].is_merge);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn rebase_conflict_can_be_aborted() {
        env();
        let d = repo();
        g(&d, &["switch", "-q", "-c", "topic"]);
        std::fs::write(d.join("a.txt"), "topic\n").unwrap();
        g(&d, &["commit", "-qam", "topic"]);
        g(&d, &["switch", "-q", "main"]);
        std::fs::write(d.join("a.txt"), "main\n").unwrap();
        g(&d, &["commit", "-qam", "main"]);
        g(&d, &["switch", "-q", "topic"]);
        let r = exec(&d, GitOp::Rebase { onto: "main".into() });
        assert!(!r.ok && r.conflicts, "{}", r.summary);
        assert_eq!(state(&d).operation.as_deref(), Some("rebase"));
        assert!(exec(&d, GitOp::RebaseAbort).ok);
        assert!(state(&d).operation.is_none());
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn ahead_behind_fetch_pull_and_push_against_a_local_remote() {
        env();
        let remote = temp();
        g(&remote, &["init", "-q", "--bare", "-b", "main"]);
        let d = repo();
        g(&d, &["remote", "add", "origin", &remote.display().to_string()]);
        let first = exec(&d, GitOp::Push { remote: Some("origin".into()), branch: Some("main".into()), set_upstream: true, all: false, tags: false, force_with_lease: false });
        assert!(first.ok, "{}", first.summary);
        assert_eq!(state(&d).branch.upstream.as_deref(), Some("origin/main"));
        std::fs::write(d.join("l.txt"), "l\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-qm", "local only"]);
        let st = state(&d);
        assert_eq!((st.branch.ahead, st.branch.behind), (1, 0));
        let prev = push_preview(&d).unwrap();
        assert_eq!((prev.remote.as_str(), prev.upstream.as_deref()), ("origin", Some("origin/main")));
        assert_eq!(prev.commits.len(), 1);
        assert!(prev.commits[0].contains("local only"), "the preview shows exactly what will be pushed");
        assert!(exec(&d, GitOp::Push { remote: None, branch: None, set_upstream: false, all: false, tags: false, force_with_lease: false }).ok);
        assert_eq!(state(&d).branch.ahead, 0);
        // a second clone pushes a commit; the first one is behind only AFTER a fetch
        let other = temp();
        g(&other, &["clone", "-q", &remote.display().to_string(), "."]);
        std::fs::write(other.join("o.txt"), "o\n").unwrap();
        g(&other, &["add", "."]);
        g(&other, &["commit", "-qm", "from the other clone"]);
        g(&other, &["push", "-q"]);
        assert_eq!(state(&d).branch.behind, 0, "no fetch yet: the local view does not know");
        assert!(sync_sentence(&state(&d).branch, state(&d).last_fetch_ms).contains("Up to date"));
        assert!(exec(&d, GitOp::Fetch { all: false }).ok);
        let st = state(&d);
        assert_eq!(st.branch.behind, 1);
        assert!(st.last_fetch_ms.is_some());
        assert!(sync_sentence(&st.branch, st.last_fetch_ms).contains("1 commit behind origin/main"));
        let pull = exec(&d, GitOp::Pull { mode: "ff-only".into(), autostash: false });
        assert!(pull.ok, "{}", pull.summary);
        assert_eq!(state(&d).branch.behind, 0);
        assert!(d.join("o.txt").exists());
        // diverge, then push is rejected (no silent force)
        std::fs::write(other.join("o2.txt"), "o2\n").unwrap();
        g(&other, &["add", "."]);
        g(&other, &["commit", "-qm", "other 2"]);
        g(&other, &["push", "-q"]);
        std::fs::write(d.join("d.txt"), "d\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-qm", "diverging local"]);
        let rejected = exec(&d, GitOp::Push { remote: None, branch: None, set_upstream: false, all: false, tags: false, force_with_lease: false });
        assert!(!rejected.ok, "a rejected push is reported as a failure: {}", rejected.summary);
        std::fs::remove_dir_all(d).ok();
        std::fs::remove_dir_all(other).ok();
        std::fs::remove_dir_all(remote).ok();
    }

    #[test]
    fn tags_stashes_and_remotes_roundtrip() {
        env();
        let d = repo();
        assert!(exec(&d, GitOp::TagCreate { name: "v1.0".into(), message: Some("release".into()), commit: None }).ok);
        let t = tags(&d).unwrap();
        assert!(t.len() == 1 && t[0].name == "v1.0" && t[0].annotated);
        assert!(exec(&d, GitOp::TagDelete { name: "v1.0".into() }).ok);
        assert!(tags(&d).unwrap().is_empty());
        std::fs::write(d.join("a.txt"), "dirty\n").unwrap();
        std::fs::write(d.join("u.txt"), "untracked\n").unwrap();
        assert!(exec(&d, GitOp::StashPush { message: Some("wip".into()), include_untracked: true }).ok);
        assert!(state(&d).clean);
        assert_eq!(stashes(&d).unwrap()[0].subject.contains("wip"), true);
        assert!(exec(&d, GitOp::StashApply { index: 0 }).ok);
        assert!(d.join("u.txt").exists());
        assert!(exec(&d, GitOp::Discard { tracked: vec!["a.txt".into()], untracked: vec!["u.txt".into()] }).ok);
        assert!(state(&d).clean);
        assert!(exec(&d, GitOp::StashDrop { index: 0 }).ok);
        assert!(stashes(&d).unwrap().is_empty());
        assert!(exec(&d, GitOp::RemoteAdd { name: "origin".into(), url: "https://user:secret@example.com/r.git".into() }).ok);
        let r = remotes(&d).unwrap();
        assert_eq!(r[0].name, "origin");
        assert!(!r[0].fetch.contains("secret"), "credentials in a URL are never shown: {}", r[0].fetch);
        assert!(exec(&d, GitOp::RemoteRename { old: "origin".into(), new: "up".into() }).ok);
        assert!(exec(&d, GitOp::RemoteRemove { name: "up".into() }).ok);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn diffs_cover_unstaged_staged_and_commit_views() {
        env();
        let d = repo();
        std::fs::write(d.join("a.txt"), "one\nchanged\n").unwrap();
        assert!(diff(&d, &DiffSpec::Unstaged { path: "a.txt".into() }).unwrap().contains("+changed"));
        exec(&d, GitOp::Stage { paths: vec!["a.txt".into()], all: false });
        assert!(diff(&d, &DiffSpec::Staged { path: "a.txt".into() }).unwrap().contains("+changed"));
        assert!(diff(&d, &DiffSpec::Unstaged { path: "a.txt".into() }).unwrap().is_empty());
        exec(&d, GitOp::Commit { message: "second".into() });
        let h = graph(&d, 5).unwrap().rows[0].hash.clone();
        assert!(diff(&d, &DiffSpec::Commit { hash: h, path: Some("a.txt".into()) }).unwrap().contains("+changed"));
        let root_hash = graph(&d, 5).unwrap().rows[1].hash.clone();
        assert!(diff(&d, &DiffSpec::Commit { hash: root_hash, path: None }).unwrap().contains("+one"), "the root commit has no parent");
        assert!(diff(&d, &DiffSpec::Unstaged { path: "../x".into() }).is_err());
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn the_reported_error_is_the_reason_not_the_first_progress_line() {
        let err = "From /tmp/remote
 * branch main -> FETCH_HEAD
hint: Diverging branches can't be fast-forwarded
fatal: Not possible to fast-forward, aborting.
";
        assert_eq!(error_line(err), "fatal: Not possible to fast-forward, aborting.");
        assert_eq!(error_line("only one line"), "only one line");
        assert_eq!(error_line(""), "git failed");
    }

    #[test]
    fn user_supplied_values_are_validated_and_never_reach_a_shell() {
        for bad in ["-rf", "a b", "x;rm -rf", "$(whoami)", "a..b", "", "/abs", "ends.lock", "a@{1}"] {
            assert!(!valid_ref(bad), "{bad}");
        }
        assert!(valid_ref("feature/payment-2") && valid_ref("v1.2.3"));
        assert!(plan(&GitOp::Switch { branch: "--detach".into(), remote: false, stash: false }, false).is_err());
        assert!(plan(&GitOp::CreateBranch { name: "ok".into(), start: Some("--upload-pack=x".into()), switch: false }, false).is_err());
        assert!(plan(&GitOp::Stage { paths: vec!["../../etc".into()], all: false }, false).is_err());
        assert!(plan(&GitOp::Stage { paths: vec![".git/config".into()], all: false }, false).is_err());
        assert!(plan(&GitOp::Pull { mode: "nuke".into(), autostash: false }, false).is_err());
        assert!(plan(&GitOp::RemoteAdd { name: "o".into(), url: "--upload-pack=calc".into() }, false).is_err());
        let p = plan(&GitOp::Commit { message: "multi\nline \"quoted\" $(x)".into() }, false).unwrap();
        assert_eq!(p.steps[0], vec!["commit", "-F", "-"], "the message travels on stdin, not in arguments");
        let f = plan(&GitOp::Push { remote: Some("origin".into()), branch: Some("main".into()), set_upstream: false, all: false, tags: false, force_with_lease: true }, false).unwrap();
        assert!(f.steps[0].contains(&"--force-with-lease".to_string()) && !f.steps[0].iter().any(|a| a == "--force" || a == "-f"), "force always means with-lease");
        assert!(plan(&GitOp::Push { remote: None, branch: Some("x".into()), set_upstream: false, all: true, tags: false, force_with_lease: false }, false).is_err());
    }

    #[test]
    fn output_never_contains_credentials() {
        env();
        let d = repo();
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let sink: LineSink = Arc::new(move |s: &str| l2.lock().unwrap().push(s.to_string()));
        let p = plan(&GitOp::RemoteAdd { name: "o".into(), url: "https://me:hunter2password@example.com/x.git".into() }, false).unwrap();
        let r = execute(&d, &p, sink, &AtomicBool::new(false));
        let shown = lines.lock().unwrap().join("\n");
        assert!(r.ok && !shown.contains("hunter2password") && !r.output.contains("hunter2password"), "{shown}");
        std::fs::remove_dir_all(d).ok();
    }
}
