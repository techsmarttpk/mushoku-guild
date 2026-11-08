# Repo tab: explorer, editor and Git workbench

The **Repo** tab is a compact IDE-style workspace for the active repository: explorer on the left, editor or graph in the centre, Git toolbar on top, optional output panel at the bottom. The repository name is always shown, and everything reloads when you switch repository.

## File explorer

- Lazy tree read by Rust; folders first. Hidden files and `.gitignore`d files stay hidden until you tick **hidden** / **ignored** (ignore rules come from `git check-ignore`).
- Create file/folder, rename (F2) and delete (Del) always ask first; important files (package.json, Cargo.toml, README, `.gitignore`...) ask again. The repository root and `.git` can never be changed or opened.
- Git status letters (M, A, D, U, !) decorate files and folders. Files over 2 MB or containing NUL bytes are not opened for editing.
- Open tabs are saved per repository (paths only) and restored. Unsaved text is never persisted.

## Editor

CodeMirror 6, loaded on demand with one language pack per language: TypeScript/JavaScript (+JSX/TSX), Python, Java, Kotlin, Rust, HTML, CSS, JSON, YAML, TOML, Markdown, SQL, shell (and C/C++/C#, Go, Ruby). No language server runs.

It has line numbers, bracket matching, folding, completion (keywords and words in the file), find/replace (Ctrl+F / Ctrl+H), indentation, a word-wrap toggle, and line/column/language/EOL/encoding in the status bar. **Ctrl+S** saves, **Ctrl+Shift+S** saves all.

Saving writes atomically (temp file + rename), keeps a file's CRLF/LF style and compares the modification time the editor saw. If the file changed on disk (a quest, Git, another program):

- a tab without edits reloads silently;
- a tab with unsaved edits shows a warning and keeps your text; saving asks whether to overwrite.

Closing a tab, switching repository or closing the window with unsaved edits asks first.

## Git operations

All Git work is done by the `git` executable from Rust (no shell). State is computed by Rust from Git (`status --porcelain=v2 -z`, `for-each-ref`, `log`) and pushed to the UI. It refreshes after your actions, after every finished quest and every 3 s while the Repo tab is open, so a `git switch` typed in any terminal appears by itself.

| Area | Operations |
|------|-----------|
| Status | branch, short hash, upstream, ahead/behind, counts of modified/staged/untracked/conflicted, merge/rebase in progress |
| Sync | fetch, fetch all, pull (fast-forward only / rebase / merge, optional autostash), push with a preview of the commits and target, set upstream, `--force-with-lease` after explicit confirmation |
| Freshness | The toolbar never claims to be up to date by itself: it says "as of the last fetch N min ago" or "never fetched here, so this may be stale". Behind counts are only as current as the last fetch. |
| Branches | switch (offers to stash), create, rename, delete (safe, then force), delete remote branch, set upstream, check out a remote branch as a tracking branch |
| Changes | stage/unstage per file or all, discard (confirmed; untracked files deleted only when you say so), commit (message required, only staged files), stash push/apply/pop/drop |
| History | lane-based graph, ref labels (HEAD, local, remote, tags), commit details with parents/files/diff, load more |
| Integrate | merge (ff / no-ff), rebase onto, abort, continue, skip, conflict dialog (ours/theirs/base, open in editor, mark resolved) |
| Remotes and tags | add, rename, remove, change URL; create, delete, push tags |

## Graph

`git log --all --topo-order` feeds a lane-assignment algorithm in Rust (`git::assign_lanes`): each commit gets a lane, pass-through lanes, converging lanes and its parents' lanes, so merges fan out and branches rejoin. The frontend only draws the segments as SVG. It loads 200 commits and more on request.

## Output panel

Three tabs: Git output (commands run, streamed output, errors with the real reason), Commands, Claude activity. The command runner starts a process in the repository **without stdin and without terminal emulation**; it needs a trusted repository, runs at most three commands at once and each has a Stop button. It is an output viewer, **not a terminal**.

## Limits

No graphical three-way merge editor, cherry-pick, interactive rebase or `git init`; no diff for binary files; outside changes are found by polling (3 s), not file-system events. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
