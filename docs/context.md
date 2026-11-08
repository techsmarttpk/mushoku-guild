# context.md — Mushoku Guild Long-Term Context

Working memory for the project. Future sessions must read this first. Every item is labelled **[Confirmed]**, **[Assumption]** or **[Open]**. Do not promote assumptions to requirements without the user's agreement (record in `docs/DECISIONS.md`).

_Last updated: 2026-11-08 (Phase 1 completed; stack, MVP scope and budgets accepted)._

## 1. What Mushoku Guild is

**[Confirmed]** A lightweight, game-inspired **desktop application** for orchestrating AI-assisted software development workflows.

## 2. The original problem

**[Confirmed]** The current manual workflow:

1. The user describes a development task to ChatGPT.
2. ChatGPT helps engineer a detailed implementation prompt.
3. The user manually copies the prompt.
4. The user pastes it into Claude Code.
5. Claude Code executes the development task.
6. The user manually reviews the result.

The goal is to **automate this workflow**, removing the manual copy/paste handoff while keeping the user in control.

## 3. Why we are building it

**[Confirmed]** To automate the above workflow.
**[Assumption]** Secondary motivations (making agent work visible and enjoyable via a game-like presentation) follow from the product direction below; the user has not ranked them.

## 4. Intended user experience

**[Confirmed as direction, not as requirements]** Agents are presented as characters inhabiting a cozy café / guild environment. Ideas under consideration:

- Agents represented as characters.
- Tasks represented as quests or orders.
- Agent activity represented visually.
- Prompt engineering and handoff between agents shown.
- Task status and execution progress shown.
- A café-like environment with a playful RPG aesthetic.

> The user stated these are *product direction ideas, not all confirmed requirements.* Which of them are in the MVP is **[Open]**.

## 5. Product vision

**[Confirmed]** Game-like presentation without sacrificing usability, backed by real agent integrations and clear visibility into agent activity.

## 6. Confirmed constraints

**Stated by the user on 2026-11-08 (intended integration):** Mushoku Guild is a locally running open-source desktop app; ChatGPT is the prompt-engineering/reasoning agent, reached through the official Sign in with ChatGPT open-source integration using the user's existing ChatGPT Go subscription (no separately billed API key); Claude Code executes via its existing CLI authentication under the user's Claude Pro subscription. These are intentions; feasibility is assessed in §11.

- Lightweight; minimal CPU and RAM.
- Avoid unnecessarily heavy game engines.
- Game-like presentation must not sacrifice usability.
- **Real functional** agent integrations, not merely simulated activity.
- Clear visibility into what agents are doing.
- The user remains in control of task execution and approvals.
- Modular architecture supporting additional agents in future.
- Do not select technologies prematurely; evaluate trade-offs first.

## 7. Assumptions (unconfirmed — do not treat as fact)

| # | Assumption | Why it matters |
|---|-----------|----------------|
| A1 | First integrations are ChatGPT (prompt engineering) and Claude Code (execution), since they are the agents in the current workflow. | Defines MVP integration scope. |
| A2 | "Desktop application" means a native-feeling app on at least Windows (the developer's current OS is Windows 11). Other OSes unknown. | Affects stack choice. |
| A3 | Integrations may be done via official APIs/CLIs rather than driving web UIs. Not yet investigated. | Feasibility of ChatGPT integration is unknown. |
| A4 | Single user, local machine, no multi-user or cloud sync. | Simplifies architecture. |
| A5 | Visual style is 2D (sprite/illustration), not 3D. | Strongly affects weight. |

## 8. Open questions

1. **ChatGPT integration route:** the documented route worked in a spike (§12). **Still open:** (a) confirm in ChatGPT Settings that the tested account is on Go; (b) official docs still name only Plus and Pro, so Go eligibility is observed, not promised; (c) refresh/revocation/usage-limit behaviour untested; (d) licence/terms review (ADR-0008). Fallback if eligibility is later withdrawn is undecided.
2. **Claude Code integration route:** the native Windows CLI as a child process works (§13). **Still open:** Anthropic's policy for an app spawning the CLI under the user's subscription is not addressed by the legal page (§11.3, §13.10); long-lived vs per-task process; behaviour on machines without Git; error paths (expired login, usage limits) untested.
3. **Which platforms** must be supported at MVP?
4. **MVP scope of the café:** static scene with status, or animated characters? How much "game" at first?
5. **Approval model:** what exactly needs approval (prompt handoff, each tool call, each task)?
6. **Review step:** should the app help automate review (e.g., a reviewer agent), or only present results for human review?
7. **Persistence:** are task history and prompts stored? For how long?
8. **Resource budgets:** concrete CPU/RAM targets (currently TBD; to be set from measured baselines).
9. **Name/IP:** art and character assets — who produces them, licensing?
10. **Distribution:** installer, auto-update, open source or private?

## 9. Current project status

- **Phase:** Phase 1 (Discovery) **completed** 2026-11-08. The user accepted ADR-0010 (stack), ADR-0011 (MVP scope) and ADR-0012 (provisional budgets). Phase 2 (Foundation) is prepared but **not started**; it begins only on the user's explicit instruction. ADR-0007, ADR-0008 and ADR-0009 remain **proposed**, and every release blocker in §15.4 remains **open**.
- Repository created at `https://github.com/techsmarttpk/mushoku-guild`, branch `main`.
- Governance and design documents established.
- **No application code exists. No technology has been chosen.**
- Integration research is done (see §11). Two spikes have run on this machine: ChatGPT Sign in with ChatGPT (§12, succeeded end to end; Go is the user's statement, the tokens do not expose the plan) and the native Windows Claude Code CLI (§13, print mode, stream-json, permissions, cancellation and login retention all exercised and working; some behaviour is undocumented and observed only on CLI 2.1.319).

## 10. Things future sessions must retain

- Documentation-first: no implementation until the user asks and the discovery phase's exit criteria in `docs/plan.md` are met.
- Do not claim integrations work until tested against the real agent.
- Tech stack selection requires a written trade-off evaluation and a `docs/DECISIONS.md` entry.
- Lightweight is a hard constraint; don't add a heavy engine or framework casually.
- The user's environment: Windows 11, Git Bash/PowerShell, working directory `D:\Projects\mushoku-guild`.

## 11. Integration research findings (Phase 1, 2026-11-08)

Sources: official OpenAI and Anthropic pages fetched 2026-11-08 by research subagents (their quotes are relayed; the lead agent did not re-read each page), plus one local test. Labels: **[Verified-doc]** = stated in an official page fetched on this date; **[Verified-local]** = observed on this machine; **[Unverified]** = not confirmed; **[Conflicting]** = sources disagree. Documentation can change; re-check before implementing.

### 11.1 ChatGPT — Sign in with ChatGPT, open-source "ChatGPT plan usage"

**Verified from official documentation**

- [Verified-doc] Plan usage is an optional capability of Sign in with ChatGPT for open-source apps and personal projects that run locally. It does not grant access to the user's ChatGPT conversations. Paid or remotely hosted apps must use a waitlist/interest form.
- [Verified-doc] Auth: OAuth 2.0 authorization code + PKCE (S256), public client, **no client secret and no API key**. Authorize `https://auth.openai.com/api/accounts/authorize`; token `https://auth.openai.com/api/accounts/oauth/token`; issuer `https://auth.openai.com`; discovery at `/.well-known/openid-configuration`.
- [Verified-doc] First-time registration uses `client_id=dynamic_agent_client` with `agent_name_hint` (the app's name) and a required `ext_agent_host_id`; OpenAI then issues a client ID (`oaiapp_...`), which must be saved and reused. The issued client is bound to the user and workspace chosen at registration.
- [Verified-doc] Host ID: opaque, stable, persisted per installation; recommended `urn:ietf:params:oauth:jwk-thumbprint:`, also `urn:uuid:` (UUIDv4) or `did:key:`. Not a credential.
- [Verified-doc] Redirect: loopback `http://127.0.0.1:<port>/auth/callback` (never `localhost`); only the port may vary; start the listener before opening the system browser. Fresh `state`, `nonce` and PKCE verifier per attempt.
- [Verified-doc] Scopes: identity `openid profile email`; plan usage `offline_access resource.invoke chatgpt.tokens.use.direct`; resource `https://api.openai.com/v1`. A valid ID token alone does not grant plan usage; check the granted scopes.
- [Verified-doc] Tokens: access token 1 hour; refresh token 30 days, rotating (each refresh returns a replacement). Refresh via the token endpoint (`grant_type=refresh_token`, issued `client_id`, `resource`). Serialize refreshes so two processes do not race the rotating token. The revocation endpoint comes from discovery.
- [Verified-doc] Storage guidance: protected file in an app-defined directory, atomic writes, owner-only permissions, never log or commit tokens; a separate record per issued client ID and verified account.
- [Verified-doc] Inference: `GET https://api.openai.com/v1/models` (use entries with `visibility == "list"`, show `display_name`, send `slug`), then `POST https://api.openai.com/v1/responses` with `store: false` and `stream: true` and the bearer access token. Do not use ChatGPT `backend-api`. Success only after a `response.completed` event; also handle `response.failed`, `response.incomplete` and interrupted streams.
- [Verified-doc] Responses API limits: use `instructions` or developer messages (explicit system-role messages are rejected); send the full history in `input` (no `previous_response_id` over HTTP); these fields must be omitted: `background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, multi_agent, prompt, prompt_cache_retention, safety_identifier, temperature, top_logprobs, top_p, truncation, user`. Image generation, file search, code interpreter, computer use, hosted MCP and `tool_search` are unsupported. Audio/video input is unsupported.
- [Verified-doc] Errors: pre-stream HTTP 401/403/503; structured codes include `subscription_sharing_usage_limit_exceeded` (429), `_usage_unavailable` (503), `_user_not_eligible` (403), `_unsupported_capability` (400), `_route_not_supported` (403), `_invalid_user` (401), `_user_unavailable` (503). Usage-limit errors can arrive mid-stream as `response.failed`. OpenAI does not silently fall back to another billing path. Refresh failures (`invalid_grant`, `refresh_token_expired`, `refresh_token_reused`, ...) mean re-running OAuth with the saved client ID. OpenAI does not notify the app when a user disconnects it; do not erase credentials on transient network errors.
- [Verified-doc] Limits: for Plus, a five-hour usage limit is shared across all apps using the plan; the five-hour limit does not apply to Pro. Users manage usage at `https://chatgpt.com/settings/usage`.
- [Verified-doc] UI requirements: sign-in action labelled "Continue with ChatGPT"; show "Using ChatGPT plan" near the model selector with a "Manage usage" link; a first-time welcome modal; show the active account; distinguish plan usage from the app's own charges; approved branding only.

**ChatGPT Go eligibility — documentation silent; observed to work in one spike (§12); not confirmed by OpenAI**

- [Verified-doc] No official developer page fetched mentions ChatGPT Go. The quickstart and cookbook say "Eligible ChatGPT Plus and Pro users" can use their plan.
- [Conflicting] An OpenAI help-center article (help.openai.com/en/articles/20001542) could not be fetched (HTTP 403). A web-search summary reported that it says Go, Plus and Pro may use plan usage in participating *commercial* apps, that a newer revision limits this to Plus and Pro, and that open-source tools "remain available to all ChatGPT users". This was not confirmed from the primary text.
- [Unverified at the time of research; **superseded by §12**] No authorization test had been run. Update: a spike on 2026-11-08 succeeded for the user's account (§12.1), but the plan type is not visible in the tokens and OpenAI's docs still name only Plus and Pro, so **Go eligibility is observed, not confirmed in writing** (§12.2).

**SDK availability and licensing**

- [Verified-doc] Official DevKit: `github.com/openai/sign-in-with-chatgpt-devkit`, packages `@siwc/local` (Node.js SDK: OAuth, credential storage, profiles, model discovery, streaming) and `@siwc/react`. The README says both are local workspaces in the repo; npm publication is not stated. Only a Node.js SDK is described (no Python/Rust/other SDK).
- [Verified-doc] **Licence: "Sign-in with ChatGPT DevKit Noncommercial License v1.0"** (not MIT/Apache; not an OSI open-source licence). Rights are granted solely for "Noncommercial Purposes"; commercial use needs a separate written agreement; redistribution is allowed only for noncommercial purposes, with the licence copy, change marks, and modifications under the same licence. It grants no access to ChatGPT or the OpenAI API, and no rights to OpenAI marks.
- [Unverified] Whether implementing the *documented protocol* ourselves (without DevKit code) avoids the DevKit licence, and what OpenAI's terms say about distributing an open-source app that uses the flow, needs a terms review. This document is not legal advice.
- [Unverified] `packages/local` source was not read; the SDK's minimum Node version is not stated (the example app needs Node 22.12+ and macOS 14+).
- [Verified-doc] The docs' examples use the model slug `gpt-6.1-sol`. Do not hard-code any model name; discover models via `/v1/models`.

### 11.2 Claude Code — headless CLI

- [Verified-local] Installed `claude` 2.1.319. `claude auth status` returns JSON with `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"` (subscription login).
- [Verified-local] `echo "Reply with exactly: OK" | claude -p --output-format stream-json --verbose --max-turns 1 --tools "" --no-session-persistence` exited 0 and emitted newline-delimited JSON: `system` events (hook_started, hook_response, and `init` with `cwd, session_id, tools, mcp_servers, model, permissionMode, apiKeySource, claude_code_version`), an `assistant` event (text "OK"), a `rate_limit_event` (five-hour/seven-day utilisation and status), and a final `result` (`subtype: success`, `is_error: false`, `num_turns`, `total_cost_usd`, `terminal_reason: completed`, `permission_denials`, `session_id`). It used the existing subscription login with no API key.
- [Verified-local] Resource note: that trivial call created about 110k cache-creation tokens (reported estimate $0.44) because the user's global configuration (skills, MCP servers, plugins, hooks) loads into every run, and the user's SessionStart hooks also ran. `--bare` avoids this but **never reads OAuth/keychain**, so it cannot be used with subscription auth.
- [Verified-doc] Flags: `-p`; prompt by argument or stdin (10 MB cap); `--output-format text|json|stream-json`; `--include-partial-messages` (token-level `stream_event`s); `--input-format`; `--max-turns`; `--max-budget-usd`; `--json-schema`; `--resume/--continue/--session-id/--fork-session`; `--no-session-persistence`; `--add-dir`; `--tools`, `--allowedTools`, `--disallowedTools`. There is no `--cwd` for `-p`; set the child process's working directory instead.
- [Verified-doc] Permissions: `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`. In `-p`, with no mode set (v2.1.302+), calls needing approval are **denied** unless an allow rule, hook, SDK callback or `--permission-prompt-tool` approves them. `--permission-prompt-tool mcp__<server>__<tool>` lets an MCP tool answer prompts; `--permission-prompts host|none` also exists (both flags are listed in the local `--help`). Denials appear as `permission_denied` events and in the result's `permission_denials`; they do not fail the run.
- [Verified-doc] Outcome detection: the result `subtype` is one of `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`; also `is_error`. `system/api_retry` events carry error categories (`rate_limit`, `authentication_failed`, ...). Exit code is 0 on success and non-zero on failure; exact numeric codes are not documented (SIGTERM gives 143). Do not rely on the exit code alone.
- [Verified-doc] Auth precedence: if `ANTHROPIC_API_KEY` is set, `-p` always uses it instead of the subscription login. The app must not set it and should warn if it is present. On Windows credentials live in `%USERPROFILE%\.claude\.credentials.json`; the app must not read it.
- [Partly superseded by §13] Items below were unverified at research time; the interrupt control request, the MCP approver contract and real tool events were since observed (§13.3–§13.5). Still unverified: numeric exit codes for auth/limit failures; the official stream-json **input** schema; the MCP `--permission-prompt-tool` request/response contract; the `PermissionRequest` hook schema; numeric exit codes; real `tool_use`/`tool_result` events; cancellation behaviour on Windows.

### 11.3 Anthropic policy relevant to Mushoku Guild

- [Verified-doc] `code.claude.com/docs/en/legal-and-compliance`: subscription OAuth is "intended exclusively for purchasers" of the plans and "designed to support ordinary use of Claude Code and other native Anthropic applications". Developers building products, including with the Agent SDK, "should use API key authentication". Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", and developers "may not collect, store, or intermediate Claude.ai credentials or session tokens". Plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". Hosts of Claude Code must not modify the binary. The page also says it does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- [Verified-doc] The page never mentions `claude -p`, headless mode, or spawning the CLI from another program.
- [Unverified] Whether a local app that launches the user's own unmodified `claude` binary, logged in by the user, counts as ordinary use is **not stated**. Our design stays as close to the permitted pattern as possible (ADR-0006): never read/copy/store Claude credentials, never set or proxy tokens, never use the Agent SDK with subscription auth, never modify the binary, one user on their own machine. Residual risk remains and should be put to Anthropic (a contact link is on the legal page) before release. Press reports of enforcement against third-party harnesses (early 2026) appeared in search results but were not verified from primary sources.

### 11.4 Cross-provider implications

- The ChatGPT route needs the full conversation history per request, no `max_output_tokens`/`temperature`, SSE streaming, and OAuth token lifecycle management. Claude Code needs a child process, NDJSON parsing and an approval channel. These differ enough that the abstraction separates **auth**, **role** and **transport** (see `docs/architecture.md` §6a).

## 12. Spike result: ChatGPT authorization test (2026-11-08)

Experiment: `spikes/chatgpt-siwc/spike.mjs` (disposable research experiment, not production code; zero dependencies, Node 24; see its README). It follows only the official docs re-read the same day (registration/sign-in and models/inference pages). Everything below was **observed on this machine** ([Verified-local]) in a single run; nothing was persisted and no token was printed. The OpenAI DevKit code was neither used nor read.

### 12.1 Results

| Step | Result |
|------|--------|
| Dynamic registration (`client_id=dynamic_agent_client`, `agent_name_hint=Mushoku Guild`, host ID `urn:uuid:…`) | **Succeeded.** The callback returned an issued `oaiapp_…` client ID. No partner approval, waitlist or API key was needed for this flow. |
| Authorization (system browser, loopback `127.0.0.1:1455/auth/callback`, PKCE S256) | **Succeeded.** User signed in and consented in the browser; callback carried `code, scope, state, client_id`; state matched. |
| Token exchange | **Succeeded.** Response fields: `access_token, id_token, refresh_token, token_type=Bearer, expires_in=3600, scope, earliest_refresh_at`. |
| ID token validation | **Passed** (RS256 signature against the discovery `jwks_uri`, issuer, audience = issued client ID, expiry, nonce). |
| Plan-usage scope | **Granted:** `chatgpt.tokens.use.direct email offline_access openid profile resource.invoke`. |
| Model discovery (`GET /v1/models`) | **Succeeded:** 5 models returned, 3 with `visibility = list`: `gpt-6-luna` (GPT-6-Luna), `gpt-5.6-terra` (GPT-5.6-Terra), `gpt-5.6-luna` (GPT-5.6-Luna). The docs' example slug `gpt-6.1-sol` was **not** in this account's list, which confirms models must be discovered, never hard-coded. |
| Streaming inference (`POST /v1/responses`, `store:false, stream:true`, first listed model `gpt-6-luna`, prompt "Say exactly: Hello, world!") | **Succeeded.** Output "Hello, world!", `response.completed` received. Usage object: 13 input tokens, 8 output tokens, 21 total, plus a per-item `attribution` breakdown. |

### 12.2 Was the Go subscription accepted?

**Observed: the signed-in ChatGPT account was accepted and plan usage worked end to end.** Caveats that keep this from being a clean "Go is eligible" claim:

- [Unverified] The tokens contain **no plan-type claim** (ID-token `https://api.openai.com/auth` held only `per_user_salt`; the access token held `per_user_salt` and `encrypted_auth_metadata`). Nothing in the run proves which plan the account is on. That it is a **ChatGPT Go** account rests on the user's statement; the user should confirm under ChatGPT Settings that the plan shown is Go (and not, for example, a Plus trial) before this is treated as settled.
- [Verified-doc, unchanged] OpenAI's developer docs still name only Plus and Pro. A successful test shows the flow currently works for this account; it is not a written commitment that Go stays eligible. The help-center article (HTTP 403 earlier) is still unread. Eligibility could change; the app must handle `subscription_sharing_user_not_eligible` gracefully.
- Single account, single run, one region/time.

### 12.3 Limits and unknowns

- Not observed: any usage-limit or rate-limit error; the size of the Go allowance. The streamed `usage` object reports tokens only. Response headers were **not** inspected, so whether remaining-quota information is exposed is unknown.
- Not tested: token refresh and rotation, revocation, reauthorization with `id_token_hint`, `instructions`/developer-message input, multi-turn history, longer outputs, `response.incomplete`/mid-stream failure handling, behaviour after the 1-hour access-token expiry, tool use, image input.
- The spike verified only RS256 ID tokens (the type returned) and handles a single account.
- The access token is a decodable JWT, but its claims are not a contract; the app should treat it as opaque.
- Side effect: authorizing created a connected-app grant ("Mushoku Guild") in the user's ChatGPT account. The spike kept the refresh token only in memory and **did not revoke it**, so the grant remains until the user disconnects it in ChatGPT Settings (or it expires after 30 days).

### 12.4 Safety and production suitability

- Safety of the experiment: the user's password was never requested (sign-in happened on `auth.openai.com`); tokens were not printed or stored; output was passed through a redactor; only documented endpoints were used; no API key, cookies, or website automation. The printed authorization URL contained only single-use values (state, nonce, PKCE challenge) and a random host ID.
- **Not suitable for production** as written (no persistence, refresh, revocation, error taxonomy, port-conflict handling, multi-account support, tests). It is suitable as **evidence**: the documented flow is implementable from the public docs with built-in libraries in roughly 200 lines, which supports the feasibility of ADR-0008. The licence/terms question for ADR-0008 remains open.
- The `spikes/` directory is committed only as disposable Phase 1 research evidence (each spike has a README saying so). It is not production code; delete it when Phase 1 concludes or when the real implementation replaces it.

## 13. Spike result: native Windows Claude Code CLI (2026-11-08)

Experiment: `spikes/claude-cli/` (`spike.mjs`, `mcp-approver.mjs`; disposable research experiment, not production code; zero dependencies, Node 24 `child_process`). It launched the user's existing native Windows `claude.exe` in print mode with `--output-format stream-json` against throwaway test projects under the system temp directory. Everything below is **observed on this machine** ([Verified-local]) unless labelled otherwise. Rules kept: no WSL, no API key, no Agent SDK, no `--dangerously-skip-permissions`, binary unmodified, credential files never read, no env values printed. Raw event logs were written outside the repo (system temp) and are not committed. A Rust launcher was **not** tried (Node was sufficient for the questions asked).

All runs used `--model haiku` (alias accepted; resolved to `claude-haiku-5-5`) to limit the user's subscription usage. Behaviour with other models was not tested.

### 13.1 Executable discovery strategy
- [Verified-local] The native installer places `claude.exe` in `%USERPROFILE%\.local\bin` and that directory is on `PATH`. A PATH search for `claude.exe` found `%USERPROFILE%\.local\bin\claude.exe` (329 MB).
- [Verified-local] Validation steps that worked: (1) file exists; (2) `claude.exe --version` prints `2.1.319 (Claude Code)` and matches `^\d+\.\d+\.\d+`; (3) `Get-AuthenticodeSignature` reports **Status `Valid`, signer `CN="Anthropic, PBC"`**, which gives a cheap integrity check that the binary is the unmodified published one; (4) `claude auth status` returns JSON (`loggedIn`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`; other fields such as email and org were deliberately not printed).
- Proposed order: user override setting → `PATH` search for `claude.exe` → `%USERPROFILE%\.local\bin\claude.exe` → manual "browse for claude.exe". `.cmd`/`.ps1` shims (npm install) are **not** launched (Node cannot spawn `.cmd` without a shell, and a shell adds quoting risk). Other install locations are unverified guesses.
- Also observed: `where bash` lists both Git Bash (`C:\Program Files\Git\usr\bin\bash.exe`) and `C:\Windows\System32\bash.exe`, which is the **WSL launcher**; the app must never invoke it. Claude Code's own Bash tool used Git Bash.

### 13.2 Process-launching strategy
- [Verified-local] `spawn(claudeExe, args, { cwd: projectDir, env, windowsHide: true, stdio: ["pipe","pipe","pipe"] })`, `shell: false`, args as an array. The prompt is written to **stdin** and stdin is closed (avoids command-line length/quoting limits; the docs cap piped stdin at 10 MB).
- [Verified-local] Flags used: `-p --output-format stream-json --verbose --no-session-persistence --disable-slash-commands --strict-mcp-config --setting-sources project,local --model haiku --tools <list> [--permission-mode … | --allowedTools … | --permission-prompt-tool …] --max-turns N`. `--verbose` is required for stream-json in print mode (per docs and used throughout).
- [Verified-local] **Environment scrubbing:** the app's own shell here carried this session's `CLAUDECODE`, `CLAUDE_CODE_*` (including a messaging token), `CLAUDE_PID`, `CLAUDE_EFFORT` and `AI_AGENT` variables. The spike removes them before spawning, as a desktop app launched normally would not have them. The child then ran as a clean session (`apiKeySource: "none"`). No `ANTHROPIC_*` variable was set; if one is, the CLI would prefer it over the subscription login (docs), so the app must detect and warn.
- [Verified-local] `--strict-mcp-config` removed the user's **claude.ai account connectors (Gmail, Docs)**, which otherwise auto-connect inside headless runs and become tools the agent can call. The app should always pass it and supply only its own MCP config.
- [Verified-local] `--setting-sources project,local` skipped the user's global plugins and hooks (the user's SessionStart hook, which ran in the earlier Phase 1 test, did not run). Whether the app should honour user-level settings is a product decision, not made here.
- Working directory is the child's `cwd` (there is no `--cwd` for `-p`); backslash Windows paths worked.

### 13.3 Streaming event schema (observed, not an official schema)
stdout is newline-delimited JSON; every line parsed (no non-JSON lines). Event `type`/`subtype` seen and their useful fields (names only; contents omitted):

| Event | Key fields observed |
|-------|--------------------|
| `system/init` | `session_id, cwd, model, permissionMode, apiKeySource, claude_code_version, tools[], mcp_servers[{name,status}], capabilities[], plugins, skills, agents, powershell_path, memory_paths, …` |
| `system/status`, `system/thinking_tokens`, `system/task_started` (`task_id, tool_use_id, description, task_type`) | progress/housekeeping |
| `assistant` | `message.content[]` blocks of `text`, `thinking`, `tool_use {id, name, input}`; `parent_tool_use_id`, `session_id`, `uuid` |
| `user` | `message.content[]` `tool_result {tool_use_id, content}`; `tool_use_result`; error results are flagged |
| `system/permission_denied` | `tool_name, tool_use_id, message` (human-readable reason, e.g. output redirection needs approval) |
| `stream_event` (only with `--include-partial-messages`) | wraps raw API events: `message_start`, `content_block_start/delta/stop` (`text_delta`, `thinking_delta`, `signature_delta`), `message_delta`, `message_stop` |
| `rate_limit_event` | `rate_limit_info {status, rateLimitType, resetsAt, unifiedWindows.five_hour/seven_day {utilization, resetsAt, status}, overageStatus, isUsingOverage}` |
| `control_response` (stream-json input only) | `response {subtype, request_id, response}` |
| `result` | `subtype` (`success`, `error_during_execution`), `is_error`, `terminal_reason` (`completed`, `aborted_streaming`), `num_turns`, `result` (text), `total_cost_usd`, `usage`, `permission_denials[]`, `session_id`, `duration_ms`, `ttft_ms`, `credential_expires_at`, `api_error_status`, `modelUsage` |

Typical successful edit: `system/init → assistant[tool_use:Write] → rate_limit_event → user[tool_result ok] → assistant[text] → result/success`. Event order is not strictly guaranteed (for example `rate_limit_event` appears between others). The schema is observed from one CLI version (2.1.319); the docs give a field table only for `api_retry`, `plugin_install` and parts of `init`, so the app must parse defensively and ignore unknown events/fields.

### 13.4 Permission handling
- [Verified-local] **Default mode in `-p` denies** anything needing approval. Asked to create a file, Claude tried `Bash` (output redirection) and then `Write`; each produced a `system/permission_denied` event followed by an error `tool_result`, the file was **not** created, `permission_denials: ["Bash","Write"]` appeared in `result`, and the run still ended `result/success`, `is_error: false`, exit code 0. A denial is therefore **not** a failure signal; the app must read `permission_denied` events and `permission_denials`.
- [Verified-local] `--permission-mode acceptEdits` allowed `Write` inside the project; the file was created with exactly the requested content, no denials.
- [Verified-local] **`--permission-prompt-tool mcp__<server>__<tool>` works for interactive-style approval.** A minimal stdio MCP server (built from raw JSON-RPC, no SDK) exposed one tool, `approve`. Claude Code started it per run (`mcp_servers: approver connected`), sent `initialize`, `tools/list`, then called the tool for the pending action with arguments **`{tool_name, input, tool_use_id}`** (for example `Bash` with `input.command` and `input.description`). The tool's reply is a text content block containing JSON:
  - allow: `{"behavior":"allow","updatedInput":<input object>}` → the command ran, the file was created, `permission_denials: []`.
  - deny: `{"behavior":"deny","message":"…"}` → the action did not run, the message was visible to Claude (it quoted the approver's name back), and `permission_denials: ["Bash"]`.
  The shape matches the Agent SDK's documented `canUseTool` result; the MCP request/response contract itself is **not documented** in the pages fetched, so this is an observed contract for 2.1.319 that may change. Round-trip to the approver was fast (the call arrived about 1.9 s into the run).
- Design consequence (proposed): the approver would be a tiny MCP server process that forwards each request to the Mushoku Guild app (loopback socket or named pipe), waits for the user's click, then returns allow/deny. The run blocks while waiting; a timeout/cancel policy is needed. It adds one more child process per run.
- [Unverified] `--permission-prompts none`, `auto` and `dontAsk` modes, `updatedPermissions` ("always allow"), `AskUserQuestion` handling, and behaviour when the approver is slow or crashes were not tested.

### 13.5 Cancellation behaviour (Windows)
| Method | Observed |
|--------|----------|
| `child.kill()` while text is streaming | Process ended immediately; Node reports `exitCode: null, signal: SIGTERM` (Windows forced termination). **No `result` event.** |
| `child.kill()` while a Bash tool was running (`ping`) | Claude exited, but **the tool's child process (`ping.exe`) survived as an orphan** (confirmed, then cleaned up manually). Not acceptable for real tasks. |
| `taskkill /PID <pid> /T /F` during the same tool run | Whole tree terminated (`conhost`, three `bash.exe`, `ping.exe`); **no orphans**; exit code 1; no `result` event. |
| Graceful: stream-json **input** with `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` written to stdin mid-stream | CLI replied `control_response {subtype:"success", response:{still_queued:[]}}`, then emitted a final **`result` with `subtype: error_during_execution`, `is_error: true`, `terminal_reason: "aborted_streaming"`**; exit code 1 after stdin was closed. Process exited cleanly. `init.capabilities` listed `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `interrupt_requeue_taken_v1`. |

Conclusions: (1) prefer the graceful stream-json interrupt, then close stdin, then wait briefly; (2) fall back to `taskkill /T /F` on the whole process tree (never bare `child.kill()`); (3) after any forced kill, treat the run as aborted with no result. The interrupt message shape is **observed, not officially documented** in the pages fetched. The documented `SIGTERM → exit 143` behaviour does not apply on Windows (not testable: Node's `kill` is a forced termination). Console Ctrl+C events (`GenerateConsoleCtrlEvent`) were **not** tried. A Windows Job Object (kill-on-close) as a safety net for crashes of the host app was not tried.

### 13.6 Error handling
- Exit code **0** for every run that produced a result, including runs with permission denials. Exit **1** after an interrupt (`error_during_execution`) and after `taskkill /F`. Node reports `null` + `SIGTERM` for `child.kill()`. Do not rely on the exit code; use the `result` event (`subtype`, `is_error`, `terminal_reason`) and treat "stream ended without a `result`" as an abort/crash.
- stderr was empty in all runs. Not exercised (and deliberately not forced, to avoid touching the login): expired/revoked login, usage-limit errors, `error_max_turns`, `error_max_budget_usd`, `api_retry` events, malformed prompts, missing Git Bash. The docs say auth failures are printed as a result on stdout and `system/api_retry` events carry categories such as `authentication_failed` and `rate_limit`.
- `claude auth status` exposes a login expiry; `result.credential_expires_at` shows the credential expiry too. The expiry date is shown by these commands; once it passes, unattended runs fail until the user logs in again with the CLI. The app should surface this date.

### 13.7 Subscription login retention (without touching credentials)
- [Verified-local] Every `claude -p` run authenticated on its own with **no interaction**, `apiKeySource: "none"`, no `ANTHROPIC_*` variable, and no credential file read or copied by the spike. `claude auth status` returned `loggedIn: true, authMethod: "claude.ai"` before and after every scenario (8 scenario runs including aborts and forced kills). So the existing Claude Pro login persists across separate child processes and across forced kills.
- The spike never ran `claude auth logout`, never set tokens, and never read `%USERPROFILE%\.claude\.credentials.json` or any keychain.
- Usage is metered against the subscription: the `rate_limit_event` (`five_hour`, `seven_day` utilisation) arrived in every run and is a ready-made status source (observed, undocumented). The five-hour utilisation read 0.06 at the start of Phase 1 and 0.16 at the end of these tests, but that figure covers the user's whole account and cannot be attributed to the spikes.

### 13.8 Resource consumption (indicative; PowerShell CIM sampled every ~0.7 s, so peaks are approximate and short runs have only 2–5 samples)
| Run | Wall time | First event | Peak working set (process tree) | Processes | Tokens (cache create / read) | Est. cost (CLI's own estimate) |
|-----|-----------|-------------|-------------------------------|-----------|------------------------------|-------------------------------|
| Minimal: one `Write`, MCP/slash/user-settings disabled (3 tools) | 4.8 s | 1.0 s | ≈ 207 MB | 2 | 3.5k / 10.1k | $0.0009 |
| Same task with the user's claude.ai connectors still loaded (41 tools), first denial run | 8.0 s | 2.2 s | ≈ 232 MB | 4 | 39.5k / 78.1k | $0.009 |
| Bash tool run (`ping`) | ≈ 8 s (cancelled) | 1.6 s | ≈ 236–285 MB | 7–8 (`conhost`, `bash` ×3, `ping`, optional MCP approver `node`) | — | — |
| Earlier Phase 1 test with the user's full global config, default model | 3.2 s | 3.2 s | — | — | 110k / 0 | $0.44 |

Takeaways: a running `claude.exe` costs roughly 200 MB of RAM even for a trivial task, so Mushoku Guild's own footprint must be judged separately from the agent it launches (the lightweight requirement applies to our app; the agent is the user's tool). Startup to first event is about 1–3 s. The dominant avoidable cost is context: `--strict-mcp-config` and disabling user settings cut cache tokens by roughly 10x and estimated cost by roughly 10–500x versus loading the user's whole configuration. Idle cost of a long-lived multi-turn stream-json process was not measured.

### 13.9 Windows-specific considerations
- Use the native `.exe`; never launch `.cmd`/`.ps1` shims; never use `C:\Windows\System32\bash.exe` (WSL).
- Kill the whole process tree (`taskkill /T /F`) because tools spawn `conhost.exe`, `bash.exe` and grandchildren; consider a Job Object so children die if the host app crashes (untested).
- Pass `windowsHide: true` to avoid console windows; use `shell: false`.
- The Bash tool relied on Git for Windows' `bash.exe`; `init.powershell_path` was also reported. Behaviour on machines without Git is **unverified** (docs fetched did not cover it).
- Scrub inherited `CLAUDE*`/`AI_AGENT` variables; detect `ANTHROPIC_*`.
- Paths with backslashes and a temp-directory project worked; paths with spaces, UNC paths and very long paths were not tested.
- Sampling processes via PowerShell/CIM works but costs a PowerShell start per sample; production code should prefer a native API.

### 13.10 Subscription and policy considerations
- The design still matches ADR-0006: the app launches the user's own, unmodified (Authenticode-valid Anthropic, PBC) binary; never reads, copies, stores or transmits credentials; sets no token or API key; does not use the Agent SDK; one user, one machine; documented CLI flags only.
- The legal page's open question stands: it does not mention spawning `claude -p` from another program, and it says plan limits "assume ordinary, individual usage". Automated, high-volume or multi-agent use could be judged not ordinary. Treat the Anthropic query (plan.md) as a release blocker, and do not market the app as a way to use the subscription on behalf of others.
- Product guardrail candidates (not decided): always pass `--strict-mcp-config`; surface subscription utilisation from `rate_limit_event`; show the login expiry; refuse to start if `ANTHROPIC_API_KEY` is set unless the user chooses API billing explicitly.

### 13.11 Limits of this spike
Single machine, single CLI version (2.1.319), small tasks, one model alias (`haiku`), Node launcher only. Undocumented behaviours used (interrupt `control_request`, MCP prompt-tool contract, event fields) may change between CLI versions; the app should pin and test against a minimum version and degrade to `taskkill` when graceful interrupt is unavailable. The test harness is not production code and is suitable only as evidence.

## 14. MVP scope — ACCEPTED (ADR-0011, 2026-11-08)

Status: **accepted by the user (ADR-0011, 2026-11-08).** Goal: the smallest version that is *genuinely useful* and demonstrates every capability the user listed, using real integrations only. One user, one project, one task at a time, Windows only. Multiple simultaneous coding agents are **not** a goal.

### 14.1 MVP requirements (must have)
| # | Capability | What the MVP delivers |
|---|-----------|----------------------|
| M1 | **2D café environment** | One fixed 2D café scene (PixiJS, WebGL) with a counter, an order board and two agent characters (a "reasoner" character for ChatGPT, an "executor" character for Claude Code). Animated states per agent: idle, thinking/streaming, waiting for approval, working (tool activity), blocked/error, done. A compact "lite" mode (static scene) and an always-visible plain-text activity panel (the accessible equivalent of the scene). Placeholder or simple original art; art quality and customisation are not in the MVP. |
| M2 | **ChatGPT as reasoning/prompt-engineering agent** | Sign in with ChatGPT (system browser, PKCE, loopback), account shown, model picker from `/v1/models`, a built-in prompt-engineering instruction, streamed draft prompt, user can edit and request revisions. Handles refresh, sign-out/revoke, usage-limit and ineligibility errors with clear messages ("Using ChatGPT plan", "Manage usage" link per OpenAI's UI rules). |
| M3 | **Claude Code executes approved tasks (native Windows CLI)** | Preflight (discover `claude.exe`, version, signature, login status, `ANTHROPIC_*` warning), launch per task in the chosen project directory with `-p --output-format stream-json`, `--strict-mcp-config`, scrubbed environment; stream output and tool activity; cancel (graceful interrupt then process-tree kill); outcome from the `result` event. |
| M4 | **Real-time activity in the café** | The scene and activity panel are driven only by real events from the two adapters (never simulated): the reasoner character reacts to ChatGPT streaming; the executor character reacts to `tool_use`, approvals and `result`. |
| M5 | **Task history and persistence** | SQLite: tasks, prompt versions, steps, approvals and decisions, bounded event log, settings. History view with search by title/date, prompt/result detail, and re-run from a previous prompt. Credentials stored via the OS (Windows Credential Manager or equivalent — storage decision still open), never in SQLite or logs. |
| M6 | **User-controlled permissions and execution** | Nothing runs without approval: (1) user approves the engineered prompt, (2) user approves starting execution with a visible policy (read-only / ask for each action / allow edits in project), (3) each pending tool action is shown for approve/deny through the approver bridge, (4) user can cancel at any time, (5) after completion the user accepts, rejects or requests changes (loops back to ChatGPT with the feedback). Default policy is deny. |
| M7 | **Resource budgets met** | The measurement gate and budgets in `docs/architecture.md` §9 pass on the reference laptop. |
| M8 | **Installable on Windows** | NSIS installer; unsigned acceptable for personal/developer use (signing is a release item, §15). |

### 14.2 MVP flow (single task)
Describe task → ChatGPT drafts prompt (streamed) → user edits/approves → user chooses policy and approves run → Claude Code executes with live café activity and per-action approvals → result summary and tool log → user accepts / requests changes / rejects → stored in history.

### 14.3 Explicitly NOT in the MVP (future features)
Multiple projects open at once; concurrent tasks or agents; additional providers (DeepSeek, others) and a provider marketplace; a reviewer/QA agent; git diff viewer and PR integration (the MVP shows Claude's summary and tool log; a changed-files list is a candidate stretch); scene customisation, skins, sound, progression/gamification, multiple café layouts; task templates and scheduling; macOS/Linux; auto-update; telemetry or crash reporting; cloud sync or multi-user; plugin system; Claude Agent SDK or API-key billing paths; remote/hosted use; voice; localisation.

### 14.4 MVP acceptance (summary; detail in `docs/plan.md`)
A real task goes end to end on the reference laptop using the user's ChatGPT plan login and Claude Pro CLI login; every execution step needed an approval; the café reflected live events; the task is in history after restart; budgets pass; no tokens in logs or the DB; documented known limitations.

## 15. Phase 1 closure: remaining questions and blockers

Nothing here is resolved by this document; items are classified by when they must be resolved. **Phase 2** is foundation (skeleton, tooling, measurement gate); **Phase 3** is the headless core plus real integrations; **release** is distribution.

### 15.1 Blockers to START Phase 2 (development blockers)
1. ~~User approval of ADR-0010 (stack), ADR-0011 (MVP scope) and ADR-0012 (budgets).~~ **Resolved 2026-11-08:** the user accepted all three (ADR-0012 as provisional engineering targets).
2. Toolchain on the development machine: install Rust (MSVC toolchain) and the Microsoft C++ Build Tools. [local] neither was detected; this is environment setup, not a design question.
3. ~~CLAUDE.md names the stack.~~ **Resolved 2026-11-08:** `CLAUDE.md` §5 and §9 now name the accepted stack and state the budget rules; stack-specific tooling is chosen in Phase 2 task 2.7.

### 15.2 Blockers to START Phase 3 (integration development)
1. Decision on ADR-0007 (ChatGPT route), ADR-0008 (self-implemented client) and ADR-0009 (provider abstraction).
2. Decision on the Mushoku Guild source licence (affects any OpenAI-derived code and what OpenAI's preview expects of open-source apps).
3. Decision on credential storage mechanism (Windows Credential Manager via a Rust crate vs DPAPI-protected file) — not yet researched beyond OpenAI's file-with-owner-permissions guidance.
4. Design of the approver bridge's local channel and its authentication (random per-run secret over a named pipe or loopback) — design only, no research left.
5. A pinned minimum Claude CLI version and the compatibility-test approach (observed behaviour is specific to 2.1.319).

### 15.3 Questions that can run in parallel with development (not blocking Phase 2 or 3 starts)
- Ask OpenAI / read the help article (HTTP 403 earlier) to confirm Go eligibility for open-source plan usage in writing.
- Refresh-token rotation, revocation, `id_token_hint` reauthorisation and usage-limit error behaviour: implement and test inside the real ChatGPT adapter (Phase 3) with the user's account. Documented by OpenAI, not yet exercised.
- Claude CLI error paths (expired login, usage limit, `error_max_turns`/budget, `--permission-prompts none`, approver timeout/crash), machines without Git for Windows, long-lived vs per-task process.
- Whether the app honours the user's global Claude settings/plugins/hooks or runs with `--setting-sources project,local`.

### 15.4 RELEASE blockers (must be resolved before any public distribution)

**All items below remain open after the 2026-11-08 approvals.** Accepting ADR-0010, ADR-0011 and ADR-0012 cleared none of them; they are tracked in the release blockers register in `docs/plan.md`.
| Area | What must be settled |
|------|----------------------|
| **OpenAI preview and licensing** | The integration is documented as a preview with listed limitations; availability, plan eligibility (docs name Plus and Pro, Go observed only) and terms may change or be withdrawn. Review OpenAI's terms and brand/UI rules for an open-source distribution; the DevKit is under a **noncommercial** licence (do not copy its code unless the licence fits); confirm that a self-implemented client following the public docs is acceptable; ship the required UI wording and "Manage usage" link; confirm paid/hosted use stays out (waitlist applies). Do not claim Go support publicly until confirmed in writing. |
| **Anthropic CLI/subscription policy** | The legal page forbids third parties from offering Claude login or routing requests through subscription credentials and says plan limits assume "ordinary, individual usage"; it does not address launching `claude -p` locally. Obtain Anthropic's answer before release; keep ADR-0006 constraints (no credential handling, unmodified binary); decide the product wording and the fallback (API-key Executor adapter) if the answer is unfavourable. |
| **Windows trust** | Code signing and SmartScreen / Smart App Control behaviour for unsigned installers [doc]; WebView2 runtime handling for machines lacking it; updater signing if updates are added later. |
| **Production security requirements** | See 15.5. |
| **Reliability** | Token refresh and revocation verified; usage-limit handling verified; CLI error paths and version-compatibility matrix tested; process cleanup guaranteed (no orphan `claude`/tool processes after cancel or app crash). |
| **Legal/compliance hygiene** | Third-party licences inventory (Tauri MIT/Apache-2.0, PixiJS MIT, rusqlite MIT, React MIT, plus dependencies); art/asset licences; privacy statement (prompts and outputs are sent to OpenAI and Anthropic and stored locally). |

### 15.5 Production security requirements (proposed baseline)
1. Credentials: OS credential facility or equivalent; owner-only permissions; atomic writes; tokens never logged, never in SQLite, never passed to the frontend; ID tokens sent only as `id_token_hint` to OpenAI; redact authorisation URLs in logs.
2. OAuth: loopback listener bound to `127.0.0.1` only, `state`/`nonce`/PKCE per attempt, issued client ID kept per account, ID-token signature and claim validation, refresh serialised; sign-out revokes the refresh token.
3. Tauri: minimal capabilities, a strict CSP, isolation pattern considered, no remote content, no frontend shell/fs/SQL permissions; only a narrow, typed command set (validated inputs) [doc: capability and CSP model].
4. Processes: spawn only the discovered, signature-checked `claude.exe` with an explicit argument list, `shell:false`, scrubbed environment (no inherited session variables), always `--strict-mcp-config`, project directory confinement, process-tree termination and a Job Object so children die with the app.
5. Approvals: default deny; the approval gate lives in the Rust core; approver bridge authenticated (per-run secret) and bound to the run; unanswered approvals time out to deny; show the exact action before approval.
6. Untrusted data: agent output, tool inputs/results and model text are untrusted; render as text, never as markup; prompt-injection mitigation is the approval gate plus least-privilege policies.
7. Data at rest: prompts and outputs may contain proprietary code; local only; retention limits; a "delete history" control; consider database encryption later (not an MVP requirement).
8. Supply chain: pinned versions, lockfiles, `cargo audit`/`npm audit` in CI, no unreviewed install scripts.
9. No telemetry; logs local, bounded and secret-redacted.
10. Single instance; the second launch focuses the first window.
