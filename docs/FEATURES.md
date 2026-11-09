# Features and status

Status words: **Working** = implemented and exercised in the running app; **Experimental** = works today but depends on something outside this project's control; **Not implemented** = listed so nobody assumes it exists.

| Area | Feature | Status |
|------|---------|--------|
| Café | PixiJS pixel-art café with Reasoner and Executor characters, speech bubbles, quest board; paused when hidden, minimised or on the Repo tab | Working |
| Workspace | Repository = workspace: conversations, quests, research, permissions, library and editor tabs are per repository; a moved repository is re-linked by its Git root commit | Working |
| Quests | Describe → ChatGPT engineers the prompt → approve → Claude Code runs; live activity; cancel; searchable history with outcome and model | Working |
| Claude Code | Detect/choose `claude.exe`, model selection (Sonnet default, Opus, Haiku, CLI default), turn limit, process-tree cleanup | Working |
| Permissions | Per-repository trust; policies read-only / ask each time / allow edits; every request decided in Rust; 10 minute approval timeout then deny | Working |
| Auto Pilot | Per-quest switch; auto-approves ordinary project Bash commands only; destructive, credential, network-transfer, global-install, process-kill, out-of-project requests still ask | Working |
| Guild Chat | ChatGPT streaming chat with saved conversations, rename, delete, search; Markdown rendering | Working (needs ChatGPT sign-in) |
| Agent collaboration | ChatGPT can request a read-only Claude investigation; findings are redacted, bounded and returned as untrusted data; manual "Ask Claude for Context" | Working |
| ChatGPT sign-in | OAuth with PKCE and loopback callback; refresh token in Credential Manager | **Experimental** (not a documented public API for third-party apps) |
| Services | Servers started by a quest are tracked; open, focus, stop; killed on exit | Working |
| Claude in Chrome | `claude --chrome` with the official extension; detection and setup help | Optional; needs Chrome and the extension |
| Library | Bookshelf of `CLAUDE.md`, root `*.md`, `docs/**/*.md`; reader with tables, code highlighting; "Ask ChatGPT about this document" | Working |
| Mermaid | Diagrams from ```` ```mermaid ```` fences in Library and chat: flowchart, sequence, class, ER, state and others; strict security level, source toggle, zoom, per-diagram error box | Working |
| Repo explorer | Rust-owned tree, hidden/ignored toggles (`.gitignore`), create, rename, delete with confirmation, Git status decorations, tab restore | Working |
| Editor | CodeMirror 6, lazy loaded: highlighting, line numbers, wrap, completion, find/replace, bracket matching, folding, save, save all, reload, external change detection | Working |
| Git workbench | Status, fetch/pull/push, branches, staging, commit, history, diffs, merge, rebase, conflicts, tags, stashes, remotes | Working — see [GIT_WORKBENCH.md](GIT_WORKBENCH.md) |
| Git graph | Lane-based graph from real history, merge commits, ref labels, details, "load more" | Working |
| Output panel | Git output, output-only command runner (trusted repositories, cancellable), Claude activity | Working; **not a terminal** |
| Installer | Unsigned NSIS installer, per-user | Working; unsigned |
| Interactive terminal | — | Not implemented |
| Three-way merge editor | — | Not implemented |
| OS file watcher | — (polling every 3 s) | Not implemented |
| Auto-update, code signing | — | Not implemented |
| Other agents (beyond ChatGPT/Claude Code) | — (the adapter boundary exists; no second adapter) | Not implemented |

## Cycle 5 additions
- **Café Atmosphere** (Guild tab): Morning / Noon / Evening / Night, Automatic (local time) or Manual.
- **Library search** (`/` or Ctrl+F): title, file name and path, case-insensitive, live count.
- **Quest attachments**: PNG, JPG, WEBP, GIF, TXT, LOG, PDF, Markdown; picker or drag and drop; Claude receives them with the approved prompt.
- **Universal Chat** tab: repository-independent conversations with ChatGPT or Claude (Claude in no-tools conversation mode). The former Chat tab is now called Guild Chat.

## Cycle 6 additions
- **To-Do** tab: global personal tasks with optional repository tag, priority, due date, filters, sorting, progress.
- **Idle conversations** between the two characters (offline, no AI).
- **Library**: search button on the shelf; the shelf resizes with the window.

## Cycle 7 additions
- **Context selector** (No Context / Project Capsule / Relevant Context / Deep Research) on quests, Guild Chat and Universal Chat.
- **OpenRouter free models**: connect, browse, test, recruit (Guild tab, rectangular + button). Free-only is enforced in four layers.
- **Guild members** appear as unique pixel characters in the café; click for chat, details, removal.
- **Universal Chat** supports recruited models, each conversation bound to its exact model.
