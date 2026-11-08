# context.md — Mushoku Guild Long-Term Context

Working memory for the project. Future sessions must read this first. Every item is labelled **[Confirmed]**, **[Assumption]** or **[Open]**. Do not promote assumptions to requirements without the user's agreement (record in `docs/DECISIONS.md`).

_Last updated: 2026-11-08 (Phase 1 integration research)._

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

1. **ChatGPT integration route:** a documented route exists (Sign in with ChatGPT plan usage, §11). **Open:** does a ChatGPT Go account qualify? Official developer docs name only Plus and Pro. Needs an authorization test or OpenAI confirmation. The fallback if not is undecided (user's own API key, another provider, or a plan upgrade).
2. **Claude Code integration route:** a CLI subprocess (`claude -p`) is verified for a trivial call. **Open:** Anthropic's policy for an app that spawns the CLI under the user's subscription is not explicitly addressed (§11.3).
3. **Which platforms** must be supported at MVP?
4. **MVP scope of the café:** static scene with status, or animated characters? How much "game" at first?
5. **Approval model:** what exactly needs approval (prompt handoff, each tool call, each task)?
6. **Review step:** should the app help automate review (e.g., a reviewer agent), or only present results for human review?
7. **Persistence:** are task history and prompts stored? For how long?
8. **Resource budgets:** concrete CPU/RAM targets (currently TBD; to be set from measured baselines).
9. **Name/IP:** art and character assets — who produces them, licensing?
10. **Distribution:** installer, auto-update, open source or private?

## 9. Current project status

- **Phase:** 1 — Discovery, in progress (Phase 0 completed). See `docs/plan.md`.
- Repository created at `https://github.com/techsmarttpk/mushoku-guild`, branch `main`.
- Governance and design documents established.
- **No application code exists. No technology has been chosen.**
- Integration research is done (see §11). Only one integration fact was tested on this machine: a trivial headless Claude Code call. The ChatGPT flow has **not** been tested, and ChatGPT Go eligibility is **unconfirmed**.

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

**ChatGPT Go eligibility — UNCONFIRMED (the current developer docs name only Plus and Pro)**

- [Verified-doc] No official developer page fetched mentions ChatGPT Go. The quickstart and cookbook say "Eligible ChatGPT Plus and Pro users" can use their plan.
- [Conflicting] An OpenAI help-center article (help.openai.com/en/articles/20001542) could not be fetched (HTTP 403). A web-search summary reported that it says Go, Plus and Pro may use plan usage in participating *commercial* apps, that a newer revision limits this to Plus and Pro, and that open-source tools "remain available to all ChatGPT users". This was not confirmed from the primary text.
- [Unverified] No authorization test with a Go account has been run. **Do not claim Go compatibility** until a test succeeds or OpenAI confirms it in writing.

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
- [Unverified] Not yet tested or not documented: the stream-json **input** schema; the MCP `--permission-prompt-tool` request/response contract; the `PermissionRequest` hook schema; numeric exit codes; real `tool_use`/`tool_result` events; cancellation behaviour on Windows.

### 11.3 Anthropic policy relevant to Mushoku Guild

- [Verified-doc] `code.claude.com/docs/en/legal-and-compliance`: subscription OAuth is "intended exclusively for purchasers" of the plans and "designed to support ordinary use of Claude Code and other native Anthropic applications". Developers building products, including with the Agent SDK, "should use API key authentication". Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", and developers "may not collect, store, or intermediate Claude.ai credentials or session tokens". Plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". Hosts of Claude Code must not modify the binary. The page also says it does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- [Verified-doc] The page never mentions `claude -p`, headless mode, or spawning the CLI from another program.
- [Unverified] Whether a local app that launches the user's own unmodified `claude` binary, logged in by the user, counts as ordinary use is **not stated**. Our design stays as close to the permitted pattern as possible (ADR-0006): never read/copy/store Claude credentials, never set or proxy tokens, never use the Agent SDK with subscription auth, never modify the binary, one user on their own machine. Residual risk remains and should be put to Anthropic (a contact link is on the legal page) before release. Press reports of enforcement against third-party harnesses (early 2026) appeared in search results but were not verified from primary sources.

### 11.4 Cross-provider implications

- The ChatGPT route needs the full conversation history per request, no `max_output_tokens`/`temperature`, SSE streaming, and OAuth token lifecycle management. Claude Code needs a child process, NDJSON parsing and an approval channel. These differ enough that the abstraction separates **auth**, **role** and **transport** (see `docs/architecture.md` §6a).
