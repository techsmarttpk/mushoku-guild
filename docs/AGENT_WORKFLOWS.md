# Agent workflows

## Roles

- **Reasoner = ChatGPT.** Writes engineering prompts and answers questions. It never touches your files or runs commands.
- **Executor = Claude Code CLI.** Edits files and runs commands in the repository, under the permission policy.
- **Guild Master = you.** You approve prompts, answer permission requests and review results.

## Quest workflow

1. **New Quest:** describe the task. Rust builds ChatGPT's instructions from a *project profile* (manifests, overview docs, Git branch, recent commits and status, entry points, directory tree; secrets excluded and redacted; 26,000 characters at most).
2. ChatGPT streams a prompt for Claude Code. You approve or reject it.
3. **Start Claude Code:** choose the policy and optional Auto Pilot (remembered per repository if you choose). Rust spawns `claude` with `stream-json`, `--model`, a turn limit and the approver.
4. Activity streams into the café (speech bubbles) and the Activity panel: messages, tool calls, results, permission decisions ("Allowed ... decided by you" versus "Auto-approved").
5. The `result` event ends the quest: Completed, Failed or Cancelled, with exit code and final answer. Background processes the quest started become **services** you can open or stop. Git state, the Library and open editor tabs refresh.
6. History is saved per repository and is searchable.

## Guild Chat and agent collaboration

- Conversations are stored in SQLite per repository. Titles come from the first real message; replies are checkpointed while streaming and marked *interrupted* if the app closes.
- ChatGPT answers directly when it can. When it needs evidence it ends its reply with a `<claude_research>` block (objective, question, paths, scope). That block is a **text protocol**: Rust filters it from what you see, validates it and bounds it.
- Rust then runs a **probe**: Claude with Read/Glob/Grep and read-only Git (`core.fsmonitor=false`, no external diff or textconv), secret paths denied, 8-minute timeout. Findings are redacted, clipped to 12,000 characters, stored as a Claude message and given back to ChatGPT as untrusted data. At most two investigations per user message; Stop cancels everything.
- **Ask Claude for Context** runs a larger read-only research whose report is attached to the conversation and marked stale when the project changes. It is never started automatically.

## Auto Pilot

Optional, per quest, off by default, never persisted. The exact boundaries are in [SECURITY.md](SECURITY.md). It reduces prompts for ordinary commands such as tests and builds; it is not a way to grant broader trust.

## Claude in Chrome

With the toggle on and the official extension installed, quests get `claude --chrome`. Browser tool calls go through the same approver and the extension keeps its own site permissions. Mushoku Guild only detects the setup, links to the official install page and passes the flag.

## Synchronisation

After a quest ends, after saves and Git operations, and every 3 s on the Repo tab, Rust re-reads Git and pushes the new state. Open editor tabs reload when clean, or warn when you have unsaved edits. Git is always the source of truth.
