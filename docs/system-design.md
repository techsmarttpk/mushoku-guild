# system-design.md — Mushoku Guild System Design

> **Status: PROPOSED.** Nothing described here is implemented. Sections labelled *Confirmed* derive from the user's stated requirements (`docs/context.md`); everything else is a proposal for Discovery to validate. Technology is TBD, so interfaces are written in language-neutral pseudo-notation.

---

# Part 1 — High-Level Design

## 1.1 Problem statement

Developers who use one AI assistant to engineer prompts and another to execute them must manually copy prompts between tools and manually track and review the outcome. This is tedious, error-prone, and gives no unified view of what each agent is doing. *(Confirmed)*

## 1.2 Product objectives

- Automate prompt creation → handoff → execution → review presentation. *(Confirmed)*
- Present agents and tasks as characters and quests/orders in a cozy café/guild scene. *(Direction, not all confirmed)*
- Keep the user in control through approvals. *(Confirmed)*
- Remain lightweight. *(Confirmed)*
- Support additional agents later. *(Confirmed)*

## 1.3 Functional requirements

Confirmed (F-C) and proposed (F-P):

| ID | Requirement | Basis |
|----|-------------|-------|
| F-C1 | User can describe a development task. | Confirmed (workflow step 1) |
| F-C2 | System obtains an engineered implementation prompt from a prompt-engineering agent. | Confirmed (step 2); intended route is ChatGPT via Sign in with ChatGPT (proposed ADR-0007, Go eligibility unconfirmed) |
| F-C3 | System hands the prompt to Claude Code without manual copy/paste. | Confirmed (steps 3–4) |
| F-C4 | Claude Code executes the task for real. | Confirmed (step 5, "real integrations") |
| F-C5 | User can see what each agent is doing and task status/progress. | Confirmed |
| F-C6 | User can review results. | Confirmed (step 6) |
| F-C7 | User approves/controls task execution. | Confirmed |
| F-C8 | New agent types can be added. | Confirmed (modularity) |
| F-P1 | Agents shown as characters; tasks as quests/orders in a café scene. | Proposed (direction) |
| F-P2 | Task history is persisted and browsable. | Proposed |
| F-P3 | User can edit a prompt before handoff. | Proposed |
| F-P4 | User can cancel a running task. | Proposed |
| F-P5 | User can request changes after review, looping back. | Proposed |

## 1.4 Non-functional requirements

| ID | Requirement | Status |
|----|-------------|--------|
| N-C1 | Minimal CPU and RAM; no heavy game engine without justification. | Confirmed |
| N-C2 | Usability is not sacrificed for presentation. | Confirmed |
| N-C3 | Modular architecture. | Confirmed |
| N-P1 | Idle CPU near zero; numeric budgets TBD after baseline measurement. | Proposed |
| N-P2 | Responsive UI: agent work never blocks the UI thread. | Proposed |
| N-P3 | Failures are surfaced clearly, never silent. | Proposed |
| N-P4 | Local-first; secrets never leave the machine except to the configured provider. | Proposed |
| N-P5 | Accessibility basics (keyboard operation, text alternative to visual state). | Proposed |

## 1.5 System boundaries

**Inside:** task management, prompt handoff, approval gating, agent adapters, event display (café), local persistence/config.

**Outside:** the AI agents themselves (ChatGPT, Claude Code), the user's code repositories, the LLM providers, OS credential store.

## 1.6 Actors and use cases

Actors: **User** (primary); **Prompt agent**; **Execution agent (Claude Code)**; future agents.

```mermaid
flowchart TB
    User((User))
    User --> UC1[Create task / order]
    User --> UC2[Review & approve engineered prompt]
    User --> UC3[Approve execution]
    User --> UC4[Observe agent activity]
    User --> UC5[Review result, accept or request changes]
    User --> UC6[Cancel task]
    User --> UC7[Configure agents & credentials]
```

## 1.7 Major components

See `docs/architecture.md` §2. Summary: UI shell, café renderer, orchestrator, agent adapters, event bus, approval gate, store, config/secrets, logger.

## 1.8 Integration points

| Point | Direction | Notes |
|-------|-----------|-------|
| Reasoner adapter (ChatGPT) ↔ `auth.openai.com` / `api.openai.com/v1` | Outbound HTTPS, SSE | OAuth+PKCE and Responses API; documented, untested (`docs/context.md` §11.1) |
| Executor adapter ↔ `claude` CLI | Child process, NDJSON stream | Headless stream-json; trivial call verified, approvals/cancel untested (§11.2) |
| Config ↔ OS credential store | Local | Proposed |
| Project working directory | Local | Where Claude Code runs |

## 1.9 Security and privacy considerations (proposed)

- Agents can run code and edit files: **execution requires explicit user approval by default**; approvals are enforced in the orchestrator, not just the UI.
- Show the user exactly what will be sent/run before approval.
- Credentials stored via OS facilities or environment; never in repo, logs, or events.
- Prompts and outputs may contain sensitive code: stored locally only; log redaction for secrets.
- Agent output is untrusted: render as text, never interpret as markup or commands.
- Restrict the agent's working directory to the user-selected project path.
- Prompt-injection risk: content returned by one agent and fed to another is data; the approval gate is the mitigation.

## 1.10 Scalability considerations

Single user, local — "scale" means *number of concurrent agents/tasks*, not users. Design for a handful of concurrent tasks; bounded event history; render cost independent of history length. Multi-user/cloud is out of scope (assumption A4).

---

# Part 2 — Low-Level Design (all proposed)

## 2.1 Module responsibilities

| Module | Responsibility | Depends on |
|--------|---------------|------------|
| `core/orchestrator` | Task state machine, routing, approvals | `agents`, `events`, `store` |
| `core/events` | Typed event definitions, bus | — |
| `core/approval` | Approval requests/decisions, policy | `events` |
| `agents/<name>` | Adapter implementing the Agent interface | external agent |
| `store` | Persistence of tasks/events/settings | — |
| `config` | Settings, secrets access | OS |
| `ui/shell` | Window, input, intents | `core` (via events/intents) |
| `ui/cafe` | Scene state derived from events | `events` |
| `log` | Structured logging | — |

Dependency rule: `ui` → `core`; `core` never imports `ui`; adapters never import `ui`.

## 2.2 Proposed interfaces (provider abstraction — PROPOSED, ADR-0009)

Pseudo-notation, not a language choice. Rationale and diagram: `docs/architecture.md` §6a.

```
ProviderInfo {
  id, displayName
  roles: ("reasoner" | "executor")[]
  auth: "oauth-app" | "cli-owned" | "api-key"
  features: { streaming, modelDiscovery, samplingParams, tokenLimit, approvalRequests }
}

interface AuthProvider {
  status(): AuthStatus             // signed_out | signed_in(account) | needs_reauth | unavailable
  signIn(): AuthFlow               // may open a browser / ask the user to run a CLI command
  signOut()
  // Reasoner-side providers expose credentials only to their own adapter, never to the core
}

interface Reasoner {                // e.g. ChatGPT, later DeepSeek
  listModels(): Model[]
  generate(req: { model, instructions, input: Message[] }): Stream<ReasonerEvent>
    // ReasonerEvent: TextDelta | Completed | Failed(ProviderError)
    // Caller owns conversation history; adapters must not depend on server-side state.
}

interface Executor {                // e.g. Claude Code
  start(job: { prompt, projectPath, policy: ApprovalPolicy }): Run
}
interface Run {
  events: Stream<RunEvent>          // Started | Output | ToolActivity | ApprovalRequest | Finished(outcome) | Failed
  respond(approvalId, decision)     // only if features.approvalRequests
  cancel()
}

interface Orchestrator {
  createTask(description, projectPath): TaskId
  approve(approvalId) / reject(approvalId, reason?)
  cancel(taskId)
  requestChanges(taskId, feedback)
  subscribe(handler): Unsubscribe
}

ProviderError { kind: not_signed_in | not_eligible | usage_limit | transient
                       | unsupported | cancelled | failed,
                providerCode?, message, retryable, retryAfter? }
```

Adapter notes (from `docs/context.md` §11; behaviour marked unverified has not been tested):

- **ChatGPT Reasoner:** sends `store:false, stream:true`; maps `instructions`; omits unsupported fields; success only on `response.completed`; maps `subscription_sharing_usage_limit_exceeded` → `usage_limit`, `_user_not_eligible` → `not_eligible`, `_unsupported_capability` → `unsupported`, refresh failures → `not_signed_in`, 503s → `transient`. Model list is discovered at run time, never hard-coded.
- **Claude Code Executor:** spawns `claude -p --output-format stream-json --verbose` in the project directory with the prompt on stdin; maps result `subtype` and `is_error` to `Finished`/`Failed` (not the exit code alone); surfaces `permission_denied` events and `permission_denials`; maps `rate_limit_event` and `api_retry` auth/rate categories to `usage_limit` / `not_signed_in`. Interactive per-tool approval depends on the unverified `--permission-prompt-tool` contract; until verified, runs use a pre-approved allowed-tools list shown to the user at approval time.
- **Future providers** implement `Reasoner` and/or `Executor` plus an `AuthProvider`; OpenAI-compatible chat APIs with an API key are expected to be the cheapest to add. Not investigated.

## 2.3 Data models

```
Task        { id, title, description, projectPath, status, createdAt, updatedAt,
              currentStepId?, prompts: PromptVersion[], result?: Result }
Step        { id, taskId, agentId, kind, status, startedAt, finishedAt, error? }
PromptVersion { id, taskId, version, text, author: "agent"|"user", approved: bool }
Approval    { id, taskId, stepId, kind, summary, status: pending|approved|rejected, decidedAt? }
Event       { id, ts, taskId?, type, payload }
AgentConfig { id, kind, enabled, settings }       // secrets by reference, not value
Result      { summary, changedFiles?, rawOutputRef?, reviewStatus }
```

## 2.4 Database design

Persistence need and engine are **TBD** (open question 7). If adopted, a small embedded store holding Tasks, Steps, PromptVersions, Approvals and an append-only Events table, with retention limits to bound size. No schema is proposed until the engine is chosen.

## 2.5 Task lifecycle

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> EngineeringPrompt: submit
    EngineeringPrompt --> AwaitingPromptApproval: prompt ready
    AwaitingPromptApproval --> EngineeringPrompt: user requests revision
    AwaitingPromptApproval --> AwaitingExecApproval: prompt approved
    AwaitingExecApproval --> Executing: approved
    Executing --> InReview: agent finished
    InReview --> Done: accepted
    InReview --> EngineeringPrompt: changes requested
    Executing --> Failed: error
    EngineeringPrompt --> Failed: error
    Draft --> Cancelled
    Executing --> Cancelled
    Failed --> EngineeringPrompt: retry
    Done --> [*]
    Cancelled --> [*]
```

(Whether prompt approval and execution approval are separate gates is an open question.)

## 2.6 Agent lifecycle

`Idle → Starting → Running → (WaitingForUser) → Finished | Failed | Cancelled`. One `AgentRun` per Step. Adapter owns process/connection cleanup; orchestrator guarantees `cancel()` on app exit.

## 2.7 Prompt lifecycle

`TaskDescription → (agent) DraftPrompt v1 → user edit/approve → ApprovedPrompt → sent to executor`. Each revision is a stored `PromptVersion`; the exact text sent to the executor is recorded for auditability. Changes requested after review produce a new prompt version linked to the same task.

## 2.8 Event handling

Typed events on an in-process bus: `TaskCreated`, `TaskStatusChanged`, `PromptDrafted`, `ApprovalRequested`, `ApprovalResolved`, `AgentStarted`, `AgentOutput`, `AgentFinished`, `AgentFailed`, `TaskCompleted`. Rules: events are immutable; handlers must not block; UI is a pure projection of events; `AgentOutput` volume is throttled/batched before rendering and bounded in memory.

## 2.9 Error handling and retries

- Classify errors: transient (network, rate limit), agent failure, user-cancel, internal.
- Retry transient errors with bounded exponential backoff (e.g. a small fixed max); never auto-retry anything that has side effects on the user's code without approval.
- Failures move the Step/Task to `Failed` with a human-readable reason and a user-visible Retry action.
- Adapter crashes/timeouts are detected and surfaced; child processes are always reaped.

## 2.10 Configuration management

Layered: defaults → user config file → environment overrides. Secrets referenced by name and resolved from the OS credential store or environment at use time. Config schema is validated on load with clear errors. Format and location: TBD.

## 2.11 Logging and observability

Structured local logs with levels, rotation and size cap; secrets redacted. Per-task correlation id on every log line and event. A user-visible activity view is the observability feature that matters most (confirmed need for visibility). Telemetry: none assumed; any telemetry would require an explicit decision.

## 2.12 Testing strategy (proposed)

Unit tests for the state machine and approval gate; contract tests for adapters using a fake agent; at least one manual or automated end-to-end test against the real Claude Code before any integration is marked verified; resource measurements recorded in `docs/plan.md`.

## 2.13 Provider authentication and token lifecycle (proposed)

**ChatGPT (app-run OAuth):**

1. On first launch generate and persist a random `urn:uuid:` host ID (opaque, not an identifier of the user).
2. Start a loopback listener on `127.0.0.1:<port>`, open the system browser to the authorize URL with fresh `state`, `nonce`, PKCE S256 challenge, the plan-usage scope set and `resource=https://api.openai.com/v1`. First time: `client_id=dynamic_agent_client`, `agent_name_hint=Mushoku Guild`, `ext_agent_host_id`.
3. Validate `state`, exchange the code, **save the issued client ID**, verify the ID token (signature via JWKS, issuer, audience, expiry, nonce), check the granted scopes include `chatgpt.tokens.use.direct`; otherwise mark plan usage disabled.
4. Persist credentials (access, refresh, ID token, expiry, scopes, client ID, host ID) in a protected per-user file, written atomically with owner-only permissions; never log them. Storage mechanism (file vs OS credential store) is TBD.
5. Refresh shortly before the one-hour access-token expiry, serialised by a single in-process lock; replace access token, expiry, scopes and the rotating refresh token together. On a terminal refresh error, clear tokens and prompt the user to sign in again with the saved client ID. Do not clear credentials on transient network failures.
6. Sign-out: revoke the refresh token at the discovered revocation endpoint (retry with backoff; tell the user if revocation was not confirmed), then clear local tokens.

All of this is documented by OpenAI but **untested** here; Go eligibility is unconfirmed (`docs/context.md` §11.1).

**Claude Code (CLI-owned):** the app never handles credentials. It runs `claude auth status` (exit 0 if logged in, 1 if not) to show state, warns if `ANTHROPIC_API_KEY` is set (the CLI would then bill that key instead of the subscription), and tells the user to run `claude auth login` themselves when signed out.

**API-key providers (future):** key stored via the OS credential facility; never in config files or logs.

## 2.14 Plan-usage and limit handling (proposed)

- Surface "Using ChatGPT plan" and a "Manage usage" link to `https://chatgpt.com/settings/usage` as required by OpenAI's UI guidelines.
- On `usage_limit` from any provider: pause new work for that provider, keep the task resumable, show the provider's own message; do not infer a reset time from the error alone and do not silently switch provider or billing path.
- Claude Code's `rate_limit_event` data (five-hour and seven-day utilisation) can feed a status display; the field set is observed (`docs/context.md` §11.2) but not documented, so treat it as best-effort.
