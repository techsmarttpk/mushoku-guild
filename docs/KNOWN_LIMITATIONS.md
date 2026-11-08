# Known limitations

Honest list for version 0.1.0.

## Distribution and platform

- The installer and executable are **not code-signed**; SmartScreen may warn.
- Windows 10/11 x64 only. No macOS or Linux build, no auto-update.
- No license has been chosen; all rights are reserved by default (see the README).
- The WebView2 runtime is downloaded by the installer if it is missing, which needs internet access.

## Integrations

- **ChatGPT sign-in is experimental.** It uses an OAuth flow and a backend endpoint that OpenAI does not document for third-party apps; it can change or be withdrawn. The ChatGPT revocation endpoint is not called on disconnect, and a ChatGPT cancel takes effect at the next streamed line.
- Whether your ChatGPT or Claude subscription terms allow this kind of use has not been resolved by this project; check the terms of your plans.
- Claude Code decides which commands need a permission request; read-only commands may never reach the approver.
- Servers a quest starts are stopped when the quest ends or the app closes unless they appear as services; they do not outlive the app.
- Claude in Chrome needs Chrome, the official extension and a CLI version that supports `--chrome`; it was verified on one CLI version only.
- Only ChatGPT and Claude Code are supported. The adapter boundary exists but no second agent has been added.

## Repo tab

- No interactive terminal. The command panel is an output viewer with no stdin.
- No graphical three-way merge editor, cherry-pick, interactive rebase or `git init`.
- No diff view for binary files; files over 2 MB or with NUL bytes are not editable.
- No OS file watcher: changes are found by a 3 s poll and by refreshes after actions and quests.
- Git authentication relies on your existing Git configuration and credential manager; prompts are disabled, so an operation that needs interactive input fails with a message.
- No language servers: highlighting and basic completion only.

## Product

- Single user, local data only; no sync between machines.
- Guild Chat has no screenshot in the README because it needs a signed-in account.
- Resource budgets in `docs/ARCHITECTURE.md` are provisional engineering targets; measurements are in `docs/measurements/`. Claude Code's own resource use is separate from the app's.
- There is no single-instance guard: starting the app twice opens two windows on the same database.
- Lint and formatter tooling has not been configured.
