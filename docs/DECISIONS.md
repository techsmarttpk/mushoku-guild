# DECISIONS.md — Decision Log (ADR style)

Only decisions actually made are recorded as `accepted`. Anything not yet agreed is `proposed`. Entries are never deleted; to change a decision, add a new entry that supersedes the old one.

Statuses: `proposed` · `accepted` · `superseded` · `rejected`

Template:

```
## ADR-NNNN: Title
- Date:
- Status:
- Context:
- Decision:
- Alternatives considered:
- Consequences:
```

---

## ADR-0001: Host the project on GitHub with `main` as the default branch
- **Date:** 2026-11-08
- **Status:** accepted
- **Context:** The project needs a remote home and a defined default branch before work begins. The user specified the repository.
- **Decision:** Use `https://github.com/techsmarttpk/mushoku-guild.git`, default branch `main`, remote name `origin`.
- **Alternatives considered:** None evaluated; the repository and branch were specified by the user.
- **Consequences:** All work is pushed to `origin/main` (or branches off it). Force-pushing and history rewriting of the remote are prohibited by `CLAUDE.md`.

## ADR-0002: Establish a documentation-first governance set
- **Date:** 2026-11-08
- **Status:** accepted
- **Context:** Work will be done across many Claude Code sessions with no shared memory; the project needs persistent rules, context, design and progress tracking before any code.
- **Decision:** Maintain six documents (location amended by ADR-0005: only `CLAUDE.md` stays at the root; the rest live in `docs/`): `CLAUDE.md` (engineering constitution), `docs/context.md` (working memory), `docs/DECISIONS.md` (this log), `docs/architecture.md`, `docs/system-design.md`, `docs/plan.md` (single source of truth for progress). Claude Code reads them before substantial changes and updates them with the work.
- **Alternatives considered:** Fewer, combined documents (rejected: different update cadences and audiences); a `docs/` subfolder (not chosen: user specified repository root).
- **Consequences:** Documentation maintenance is part of every task. Documents must stay mutually consistent.

## ADR-0003: Defer technology selection until trade-offs are evaluated
- **Date:** 2026-11-08
- **Status:** accepted
- **Context:** The user requires that technologies not be selected prematurely and that trade-offs be evaluated, given strict lightweight constraints and the avoidance of heavy game engines.
- **Decision:** No language, UI toolkit, runtime, storage engine or rendering approach is chosen yet. Selection happens in Phase 1 (Discovery) via a written evaluation, recorded in a later ADR.
- **Alternatives considered:** Picking a familiar stack now (rejected: contradicts the user's instruction and risks violating the lightweight constraint).
- **Consequences:** `docs/architecture.md` marks all stack items TBD. No implementation work begins until a stack ADR is accepted.

## ADR-0004: No application features during repository initialisation
- **Date:** 2026-11-08
- **Status:** accepted
- **Context:** The user instructed that initialisation establish a reliable foundation before building the café, orchestration engine or UI.
- **Decision:** The initialisation task produces only repository setup, `.gitignore`, and the six documents.
- **Alternatives considered:** Scaffolding a skeleton app (rejected: depends on the undecided stack).
- **Consequences:** Phase 0 contains no product code; implementation phases start only after Discovery exits.

## ADR-0005: Keep CLAUDE.md at the root; move other documentation to `docs/`
- **Date:** 2026-11-08
- **Status:** accepted
- **Context:** ADR-0002 placed all six documents in the repository root. The user wants a tidier root while keeping `CLAUDE.md` auto-discoverable by Claude Code.
- **Decision:** `CLAUDE.md` stays at the repository root. `context.md`, `DECISIONS.md`, `architecture.md`, `system-design.md` and `plan.md` live in `docs/`. This amends the location part of ADR-0002 (which otherwise stands).
- **Alternatives considered:** Leaving everything in the root (rejected by the user); moving `CLAUDE.md` too (rejected: breaks automatic discovery).
- **Consequences:** All cross-references use `docs/<file>.md` paths. `CLAUDE.md` lists where each document lives.

---

## ADR-0006: Claude Code is driven through the unmodified `claude` CLI under the user's own login; the app never handles Claude credentials
- **Date:** 2026-11-08
- **Status:** accepted
- **Context:** The user specified that Claude Code should operate through its existing CLI authentication under their Claude Pro subscription. Anthropic's legal page restricts third-party developers from offering Claude.ai login or routing requests through subscription credentials, and does not address spawning the CLI (`docs/context.md` §11.3).
- **Decision:** The Claude Code adapter launches the user's installed, unmodified `claude` binary as a child process (headless `-p` mode) and relies on the login the user has already completed. The app never reads, copies, stores or transmits Claude credentials or tokens, never sets `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` on the user's behalf, and does not use the Agent SDK with subscription authentication.
- **Alternatives considered:** Agent SDK with an API key (does not use the subscription; remains a possible future alternative adapter); reading the CLI's stored token (prohibited by the policy text).
- **Consequences:** The app detects login state through `claude auth status` and asks the user to log in with the CLI themselves. Policy risk is reduced but not eliminated and must be reconfirmed with Anthropic before release (`docs/plan.md` Phase 1). If the project is ever sold or hosted, this decision must be revisited.

---

## Proposed (not decided)

Nothing below is accepted. Each needs the user's agreement and, where noted, evidence first.

### ADR-0007 (proposed): Use Sign in with ChatGPT plan usage as the ChatGPT route
- **Date proposed:** 2026-11-08
- **Context:** The user wants ChatGPT as the prompt-engineering agent using an existing ChatGPT Go subscription with no API key. A documented official route exists for open-source local apps, but the current developer docs name only Plus and Pro, and Go is untested.
- **Proposed decision:** Pursue this route, gated on a successful authorization test with the user's Go account (or written OpenAI confirmation) and a terms/licence review.
- **Alternatives considered:** An OpenAI API key (separately billed, contradicts the user's goal); another provider such as DeepSeek through an API key; upgrading to Plus.
- **Consequences if accepted:** Mushoku Guild must be open-source and local, follow OpenAI's UI/UX rules, and handle OAuth tokens and usage limits. If the Go test fails, a fallback decision is required.
- **Accept when:** The Go test passes, or the user chooses to proceed regardless.
- **Evidence update (2026-11-08, `docs/context.md` §12):** A spike authorized, listed models and streamed an inference successfully with the user's account, so the gating test has passed in practice. Caveats: the plan type is not visible in the tokens (Go is the user's statement), OpenAI's docs still name only Plus and Pro, and refresh/usage-limit behaviour and the terms review are outstanding. **Status remains `proposed`; it has not been accepted.** It needs the user's explicit decision.

### ADR-0008 (proposed): Implement the documented protocol ourselves instead of depending on the DevKit
- **Date proposed:** 2026-11-08
- **Context:** The DevKit is a Node-only SDK under a noncommercial licence and is not stated to be published on npm; depending on it would constrain the undecided stack and the project's own licence.
- **Proposed decision:** Implement the small documented OAuth/PKCE + Responses SSE client behind our own adapter, using the DevKit only as a reference, subject to a licence/terms review.
- **Alternatives considered:** Depending on or vendoring `@siwc/local` (licence and stack coupling); the Codex app-server route (adds a heavy dependency).
- **Accept when:** The licence/terms review concludes this is acceptable.
- **Evidence update (2026-11-08, `docs/context.md` §12):** The spike implemented the documented flow from the public docs alone (no DevKit code used or read) in about 200 lines with Node built-ins, which shows technical feasibility. The licence/terms question is unresolved. **Status remains `proposed`.**

### ADR-0009 (proposed): Provider abstraction with separate auth, role and capability interfaces
- **Date proposed:** 2026-11-08
- **Context:** See `docs/architecture.md` §6a.
- **Proposed decision:** Two provider roles (Reasoner for prompt engineering, Executor for task execution), a separate auth interface, a shared error taxonomy, and a registry, so new providers (for example DeepSeek) are adapters only.
- **Alternatives considered:** One universal "Agent" interface (the earlier sketch), which mixes streaming chat with long-running tool-using jobs and forces a lowest-common-denominator design.
- **Accept when:** The user reviews it and it is validated against both real adapters in Phase 3.

### Other candidate decisions (not yet drafted)
- UI/runtime technology and rendering approach.
- Local persistence approach and token storage mechanism.
- Approval model granularity (prompt approval, run approval, per-tool approval via an MCP prompt tool).
- Project licence for Mushoku Guild (affects any use of OpenAI DevKit code).
