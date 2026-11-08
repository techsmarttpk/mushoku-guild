# spikes/claude-cli — DISPOSABLE research experiment

> **Not production code.** This is a throwaway Phase 1 experiment that produced evidence for `docs/context.md` §13. It is not part of the application, must not be imported or built upon, and will be deleted or replaced once the real implementation exists (Phase 3). Its correctness was only checked on one machine against **Claude Code CLI 2.1.319 on Windows**.

## What it tests
Launching the user's existing **native Windows** `claude.exe` as a child process in print mode (`-p --output-format stream-json`): executable discovery, version/signature/auth-status checks, event parsing, permission denial and approval, cancellation, and login retention.

## Experimental, version-specific behaviour
Some behaviour used here is **not covered by Anthropic's official documentation** and was only observed on CLI 2.1.319. It may change or disappear in any release:
- the stream-json **input** `control_request` / `interrupt` message used in the `interrupt` scenario;
- the request and reply shape of an MCP server used with `--permission-prompt-tool` (`mcp-approver.mjs`);
- the exact fields of stream-json events (`system/init`, `permission_denied`, `result`, `rate_limit_event`, ...).

## Safety properties
- No Anthropic API key, no Agent SDK, no WSL, no `--dangerously-skip-permissions`; the binary is never modified.
- Never reads or writes Claude credential files and never touches tokens. It only calls `claude auth status` and runs `claude -p`. The user's existing login is used as-is.
- Inherited `CLAUDE*`/`AI_AGENT` session variables are removed from the child environment (names only are ever printed, never values).
- Always passes `--strict-mcp-config` so the user's claude.ai connectors (for example mail or docs) are not available to the test child.
- Test projects are created in the system temp directory. Raw event logs are written to `%TEMP%\mushoku-claude-spike-logs` (outside the repository; they can contain prompts, file paths and tool inputs, so do not share or commit them).
- Uses the `haiku` model alias by default (override with `SPIKE_MODEL`) and tiny prompts to limit subscription usage. Every run does consume some of the user's Claude usage.

## Run (Node 20+, no install, no dependencies)
```
node spikes/claude-cli/spike.mjs discover
node spikes/claude-cli/spike.mjs run <deny|allow|cancel-kill|cancel-tree|mcp-deny|mcp-allow|interrupt>
```
`CANCEL_METHOD=kill|taskkill-tree` selects the method for `cancel-tree`. `cancel-tree` starts a short `ping` and the script removes any orphan it finds. Scenarios `allow`, `mcp-allow` and `cancel-tree` let the model run commands inside a temporary project directory.

## References
https://code.claude.com/docs/en/cli-reference · https://code.claude.com/docs/en/legal-and-compliance
