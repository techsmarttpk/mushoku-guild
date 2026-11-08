# Security model

Mushoku Guild runs AI agents against your source code, so the design goal is: **the user decides, Rust enforces, nothing secret leaves the machine by accident.** This page states what is enforced, where, and what is not covered.

## Trust boundaries

| Boundary | Rule |
|----------|------|
| Frontend ↔ Rust | The webview can only call named Tauri commands. Capabilities are `core:default` plus window destroy (closing after the unsaved-changes prompt). No shell, filesystem, HTTP or SQL plugin is exposed. |
| CSP | `default-src 'self'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; frame-ancestors 'none'`. Styles allow inline (PixiJS and CodeMirror need it). |
| Rust ↔ repository | `fsops.rs` accepts only repository-relative paths, rejects `..`, drive and UNC prefixes, reserved Windows names and `.git`, canonicalises targets and requires them to stay under the canonical root. Symlinks are listed but never followed. |
| Rust ↔ Git | `git` is launched with an argument array (no shell), `GIT_TERMINAL_PROMPT=0`, `core.fsmonitor=false`. Branch, tag and remote names, revisions and paths are validated before use. |
| Rust ↔ Claude Code | Claude runs with the user's own CLI login. Session variables and `ANTHROPIC_API_KEY`/`AUTH_TOKEN` are removed from its environment; `--strict-mcp-config`, `--setting-sources project,local`, `--disable-slash-commands`. `--dangerously-skip-permissions` is never used (a unit test asserts this). |
| Agent output | Treated as untrusted data everywhere: rendered as React text and structured Markdown (no HTML injection), redacted before storage, and given to ChatGPT labelled as untrusted. |

## Permission enforcement

1. **Repository trust.** A repository must be explicitly trusted before a quest can run or commands can be executed. Trust is stored with the repository identity and path; if the folder moves or is replaced, trust must be confirmed again. "Reset and revoke trust" deletes the profile.
2. **Policies** (per repository): *read-only* (Read/Glob/Grep only), *ask each time* (default), *allow edits* (the approver auto-allows Edit/Write inside the project for non-sensitive file names; Bash still asks). The CLI's own `acceptEdits` mode is deliberately not used because it would also allow `rm`/`mv` without asking.
3. **Approver.** Every permission request from Claude Code goes through an MCP approver (this executable) to the Rust core, which applies the policy and decides or asks you. No answer within 10 minutes means deny.
4. **Auto Pilot** (off by default, per quest, never persisted) only considers Bash requests and approves ordinary project commands. It always escalates destructive commands, system/registry/disk changes, anything touching credentials, network transfers, global installs, process killing, command substitution and paths outside the project. Browser tool calls are approved automatically only if plainly read-only.
5. **Research and probe runs** (Guild Chat) are read-only: Read/Glob/Grep, plus Bash limited to read-only Git; secret-looking paths are denied; nothing outside the project is allowed.
6. **Git force push** uses `--force-with-lease` only, and only after an explicit confirmation. Discard, delete and similar destructive Git or file operations require confirmation in the UI and a `confirmed` flag checked in Rust.
7. **Command runner** (Repo tab output panel) works only in trusted repositories, has no stdin, runs under a Job Object and can be stopped.

## Credentials

- **ChatGPT:** only the refresh token is persisted, in **Windows Credential Manager** (service "Mushoku Guild", stored in chunks). The access token lives in memory. Your ChatGPT password is never seen by the app. The revocation endpoint is **not** called on disconnect (known gap).
- **Claude Code:** Mushoku Guild never reads, stores or forwards Claude credentials; the CLI uses its own login.
- **Git:** Mushoku Guild never asks for, stores or logs Git credentials. Authentication is left to Git and Git Credential Manager; prompts are disabled, so an operation that needs a password fails with a message instead of hanging. URLs and output are redacted before display.
- Nothing secret is written to SQLite, logs or events. Secret-looking strings (private keys, JWTs, `sk-`/`ghp_`/AKIA/xox tokens, `key=value` pairs, URL credentials) are redacted from project context, research results and Git output.
- Files never read into prompts or the Library: `.env*`, keys and certificates, names containing credential/secret/password/private/token, databases, logs, archives, binaries, images.

## Distribution

The installer and executable are **not code-signed**. Windows SmartScreen may warn on first run; verify the SHA-256 checksum published with the release. The app does not auto-update.

## What this does not protect against

- A malicious or compromised `claude.exe` or `git.exe` on your PATH.
- Commands you approve: approving a Bash command lets it do what that command does.
- Claude Code deciding by itself that a read-only command needs no permission request (it never reaches the approver).
- Another local process running as your Windows user: it can read the app database (secrets are in Credential Manager, which is user-scoped).
- Servers started by quests listen on your machine without isolation beyond your firewall.

Report security problems privately to the repository owner via GitHub.
