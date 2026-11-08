# Development guide

## Prerequisites

| Tool | Notes |
|------|-------|
| Windows 10/11 x64 | The only supported platform |
| Node.js 24 and pnpm | `pnpm install` |
| Rust (stable, **MSVC** toolchain) | `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio 2022 Build Tools | "Desktop development with C++" (MSVC, Windows SDK) |
| WebView2 runtime | Present on Windows 11; the installer bootstraps it elsewhere |
| Git | Used by the app itself and by the tests |
| Claude Code CLI | Only needed to run quests; tests do not require it |

## Commands

```powershell
pnpm install
pnpm tauri dev                 # development app with hot reload
pnpm typecheck                 # tsc --noEmit
pnpm test                      # node --test on src/**/*.test.ts
cd src-tauri; cargo test       # Rust tests (temporary Git repositories, no network)
pnpm build                     # type-check + production frontend into dist/
pnpm tauri build               # release build and NSIS installer
```

Lint and formatter configuration (ESLint/Prettier/clippy/rustfmt) has **not** been set up; type-checking (`strict`) and the test suites are the enforced checks.

The installer is written to `src-tauri/target/release/bundle/nsis/Mushoku Guild_<version>_x64-setup.exe` and the executable to `src-tauri/target/release/mushoku-guild.exe`.

## Tests

- **Rust** (`src-tauri/src/*`): unit tests plus tests that build real temporary Git repositories (merges, conflicts, rebase, push/pull against a local bare remote), file-system safety tests and the Claude argument/approval logic. They never touch your repositories.
- **Frontend** (`src/**/*.test.ts`): pure logic only (store reducer, Markdown parser, editor-tab and graph geometry, bubbles, shelf).
- **End to end** (`tools/e2e/`): scripts that start the real **debug** app built with `--features dev-seed`, connect through the WebView2 debug port and exercise the UI against a disposable repository: `repo.mjs` (Mermaid, explorer, editor, Git), `repo-claude.mjs` (needs the Claude CLI; a real quest changes Git while the Repo tab is open), `shots.mjs` (README screenshots). Build the debug app with `pnpm tauri build --debug --no-bundle -- --features dev-seed`. **The `dev-seed` feature must never be enabled in a release build**; it is off by default. These scripts add a project to the app database of the machine they run on, so remove it afterwards.

## Repository conventions

Rules for contributors, human or AI, are in [../CLAUDE.md](../CLAUDE.md): Conventional Commits, small verifiable changes, documentation updated with the code, no unmeasured performance claims. Architectural decisions go to [DECISIONS.md](DECISIONS.md).

## Release process

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (keep them equal).
2. `pnpm typecheck`, `pnpm test`, `cargo test`.
3. `pnpm tauri build`; install the result and check that it starts, tabs open and existing data loads.
4. Copy the installer and executable to `release/` (git-ignored) with versioned names and write SHA-256 checksums.
5. Commit, tag `v<version>` on that commit, push, and (optionally) publish a GitHub Release with the installer attached.

## Where things live

See [ARCHITECTURE.md](ARCHITECTURE.md#source-layout).
