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
- **Decision:** Maintain six documents (location amended by ADR-0005: only `CLAUDE.md` stays at the root; the rest live in `docs/`): `CLAUDE.md` (engineering constitution), `docs/context.md` (working memory), `docs/DECISIONS.md` (this log), `docs/ARCHITECTURE.md`, `docs/system-design.md`, `docs/plan.md` (single source of truth for progress). Claude Code reads them before substantial changes and updates them with the work.
- **Alternatives considered:** Fewer, combined documents (rejected: different update cadences and audiences); a `docs/` subfolder (not chosen: user specified repository root).
- **Consequences:** Documentation maintenance is part of every task. Documents must stay mutually consistent.

## ADR-0003: Defer technology selection until trade-offs are evaluated
- **Date:** 2026-11-08
- **Status:** accepted
- **Context:** The user requires that technologies not be selected prematurely and that trade-offs be evaluated, given strict lightweight constraints and the avoidance of heavy game engines.
- **Decision:** No language, UI toolkit, runtime, storage engine or rendering approach is chosen yet. Selection happens in Phase 1 (Discovery) via a written evaluation, recorded in a later ADR.
- **Alternatives considered:** Picking a familiar stack now (rejected: contradicts the user's instruction and risks violating the lightweight constraint).
- **Consequences:** `docs/ARCHITECTURE.md` marks all stack items TBD. No implementation work begins until a stack ADR is accepted. **Update 2026-11-08:** satisfied by ADR-0010; implementation still waits for the user's explicit Phase 2 start.

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
- **Decision:** `CLAUDE.md` stays at the repository root. `context.md`, `DECISIONS.md`, `ARCHITECTURE.md`, `system-design.md` and `plan.md` live in `docs/`. This amends the location part of ADR-0002 (which otherwise stands).
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

## ADR-0010: Technology stack — Tauri 2, Rust core, TypeScript + React UI, PixiJS (WebGL), SQLite via rusqlite
- **Date:** 2026-11-08 (proposed and accepted the same day after the user's review of the Phase 1 findings)
- **Status:** accepted (by the user)
- **Context:** ADR-0003 deferred the stack until evaluated. The user proposed Tauri 2, React + TypeScript, PixiJS, Rust and SQLite. The evaluation (`docs/ARCHITECTURE.md` §11) covered Windows, lightweight use, developer experience and the integration needs shown by the spikes (child processes with tree kill, loopback OAuth, SSE streaming, credential storage, SQLite). The Rust and C++ build toolchain is not installed on the development machine.
- **Decision:** Adopt Tauri 2 (WebView2 on Windows) with a Rust core that owns the orchestrator, providers, processes, OAuth, credential storage and SQLite (rusqlite, `bundled`); a TypeScript + React frontend that is a thin projection of core events; PixiJS v8 with the WebGL renderer driven by a render-on-demand loop; NSIS installer. The frontend gets no shell, filesystem or SQL permissions.
- **Alternatives considered:** Electron (bundles Chromium, contradicts the lightweight goal); .NET WPF/WinUI + SkiaSharp (possibly lighter and Windows-only; the named fallback); Rust-native egui/iced/Slint (weaker for sprite scenes); Godot or other engines (ruled out by the user); Qt/QML (licensing and tooling weight); Preact/Solid/Svelte instead of React (marginal gain, not chosen).
- **Consequences:** Rust and MSVC build tools must be installed; Rust skills are required for the core; the product is Windows-first; Tauri's security model must be configured deliberately (minimal capabilities, strict CSP); `CLAUDE.md` names the stack; Phase 2 starts with a skeleton and a measurement step.
- **Verification and revisit rule:** The Phase 2 measurement gate (`docs/plan.md` task 2.6) verifies the assumptions behind this decision (WebView2 footprint, hidden-window behaviour, Pixi idle behaviour). The stack is accepted; if the evidence shows it cannot meet the targets in ADR-0012 or compromises stability or security, the evidence must be documented and a revision (including the .NET + Skia fallback) proposed to the user. This ADR is changed only by a new, user-approved ADR that supersedes it.
- **Known risks (updated after the Phase 2 gate, `docs/ARCHITECTURE.md` §13):** WebView2 memory measured (84 MB private for a blank page, 90–96 MB for the scene; the summed working set metric is misleading); WebView2 does not report minimise/hide to the page (worked around with a Rust event); Pixi's internal system ticker and any `requestAnimationFrame` loop cost about 1.7% CPU (handled in the scene controller); AnimatedSprite stepping and render-on-demand verified; discrete GPU used by default (utilisation about 0%). Still open: memory growth over hours, `TrySuspend` benefit, real-world numbers with providers and SQLite.

## ADR-0011: MVP scope
- **Date:** 2026-11-08 (proposed and accepted the same day)
- **Status:** accepted (by the user)
- **Context:** The user asked for the smallest genuinely useful version demonstrating a working 2D café, ChatGPT as reasoning/prompt agent, Claude Code executing approved tasks via the native Windows CLI, real-time activity in the café, task history and persistence, and user-controlled permissions. Multiple simultaneous coding agents are not desired.
- **Decision:** The MVP is requirements M1–M8 in `docs/context.md` §14: Windows only, single user, one project, one active task at a time, two initial agents (ChatGPT as Reasoner, Claude Code as Executor), real event-driven café animations (never simulated), SQLite task history, user-controlled execution and permissions with default deny, resource budgets per ADR-0012, NSIS installer. Everything in `docs/context.md` §14.3 is out of scope for the MVP.
- **Alternatives considered:** A headless-only first release with no café (rejected: fails the product vision); an animated multi-agent guild (rejected: scope, budget and the user's wish to avoid concurrent agents); simulating agent activity to demo early (rejected: violates "real functional integrations").
- **Consequences:** Providers beyond ChatGPT and Claude Code, diff/review tooling, customisation and cross-platform work are deferred. The provider abstraction (ADR-0009, still proposed) is to be proven by two real adapters rather than designed for many. Accepting this ADR does **not** accept ADR-0007, ADR-0008 or ADR-0009, and does **not** clear any release blocker (`docs/context.md` §15.4).

## ADR-0012: Resource budgets as provisional engineering targets
- **Date:** 2026-11-08 (proposed and accepted the same day, with the user's qualifications below)
- **Status:** accepted (by the user) **as provisional engineering targets**, not as requirements met
- **Context:** The user wants measurable CPU, RAM, startup and idle targets for a 16 GB laptop with a GTX 1650, without assuming multiple simultaneous agents. No measurement of the stack exists yet.
- **Decision:** Adopt the v0 budget table in `docs/ARCHITECTURE.md` §9 as provisional targets (for example idle RAM ≤ 180 MB, idle CPU ≤ 2% focused and ≤ 0.3% hidden, cold start ≤ 2.5 s, installer ≤ 15 MB) with the listed hard limits, on the reference laptop, for the Mushoku Guild process tree. The user's qualifications are binding:
  1. **Measure, do not assume.** No budget is considered met, and no figure is quoted as a result, without a recorded measurement.
  2. **Stability and security take priority** over meeting any performance number. A target is never met by weakening approvals, isolation, credential handling, process cleanup or error handling.
  3. **Unrealistic targets are revised with evidence.** If measurement shows a target is unrealistic, document the evidence (method, numbers, environment) and propose a revised target to the user; targets change only through a recorded, user-approved amendment to this ADR.
  4. **Claude CLI consumption is measured separately.** `claude.exe` and its child processes are the user's tool and are reported separately from Mushoku Guild's own usage; budgets apply to Mushoku Guild only. Combined figures may be reported for information but are not budget inputs.
- **Alternatives considered:** No numeric budgets (rejected: the requirement says measurable); tighter numbers copied from other apps (rejected: no baseline for this stack); including `claude.exe` in the budget (rejected: it dominates the total and is outside the app's control).
- **Phase 2 gate result (2026-11-08):** measured; RAM as literally defined fails, everything else measured passes. Evidence and the proposed amendment A: `docs/ARCHITECTURE.md` §13 and the entry under "Proposed" below. **No change to this ADR has been made.**
- **Amendment A (ACCEPTED 2026-11-08 by the owner):** the memory budget metric is the **private working set of the Mushoku Guild process tree** (app + WebView2 processes; `claude.exe` still excluded and measured separately). Targets: **idle <= 120 MB, active <= 140 MB** (hard limits 150 / 180 MB). The original figures (180/260 MB summed working set) are kept above as the original wording. Evidence for the change: a blank Tauri + WebView2 page already sums to 355 MB of working sets because the seven WebView2 processes share pages, so the summed metric double-counts and cannot be met by any app on this stack; the measured private working set is 84 MB blank / 90 MB idle / 96 MB active (`docs/ARCHITECTURE.md` §13, `docs/measurements/phase2/`). Summed working set is still reported next to it. Two design rules from measurement are adopted: no `requestAnimationFrame` loop in idle states, and all renderer tickers stopped when minimised. Open metrics: 8 h memory growth, idle disk writes, visible-but-unfocused CPU, first-launch start-up.
- **Consequences:** The Phase 2 gate produces the first real measurements; performance regressions become test failures only for metrics with recorded baselines; the "lite" mode is a first-class feature.

---

## Proposed (not decided)

**Phase 3 note (2026-11-08):** the owner's Phase 3 instruction directs implementing the Sign in with ChatGPT integration (ADR-0007, ADR-0008) and a Reasoner/Executor provider boundary (ADR-0009). These are therefore **accepted for implementation as an EXPERIMENTAL integration**; their entries below are kept with their original text and a status note. This does **not** resolve the external blockers: OpenAI documents only Plus/Pro for this flow (Go eligibility is unconfirmed and must never be claimed), the DevKit/terms licence review is open, and Anthropic's third-party subscription-use policy is open (`docs/plan.md` release blockers). Nothing is to be marketed or distributed as approved until those are resolved.

### ADR-0007 (proposed): Use Sign in with ChatGPT plan usage as the ChatGPT route
- **Date proposed:** 2026-11-08
- **Context:** The user wants ChatGPT as the prompt-engineering agent using an existing ChatGPT Go subscription with no API key. A documented official route exists for open-source local apps, but the current developer docs name only Plus and Pro, and Go is untested.
- **Proposed decision:** Pursue this route, gated on a successful authorization test with the user's Go account (or written OpenAI confirmation) and a terms/licence review.
- **Alternatives considered:** An OpenAI API key (separately billed, contradicts the user's goal); another provider such as DeepSeek through an API key; upgrading to Plus.
- **Consequences if accepted:** Mushoku Guild must be open-source and local, follow OpenAI's UI/UX rules, and handle OAuth tokens and usage limits. If the Go test fails, a fallback decision is required.
- **Accept when:** The Go test passes, or the user chooses to proceed regardless.
- **Evidence update (2026-11-08, `docs/context.md` §12):** A spike authorized, listed models and streamed an inference successfully with the user's account, so the gating test has passed in practice. Caveats: the plan type is not visible in the tokens (Go is the user's statement), OpenAI's docs still name only Plus and Pro, and refresh/usage-limit behaviour and the terms review are outstanding. **Status: accepted for experimental implementation by the owner's Phase 3 instruction (2026-11-08); eligibility, terms and refresh/usage-limit behaviour still to be verified in the product.**

### ADR-0008 (proposed): Implement the documented protocol ourselves instead of depending on the DevKit
- **Date proposed:** 2026-11-08
- **Context:** The DevKit is a Node-only SDK under a noncommercial licence and is not stated to be published on npm; depending on it would constrain the undecided stack and the project's own licence.
- **Proposed decision:** Implement the small documented OAuth/PKCE + Responses SSE client behind our own adapter, using the DevKit only as a reference, subject to a licence/terms review.
- **Alternatives considered:** Depending on or vendoring `@siwc/local` (licence and stack coupling); the Codex app-server route (adds a heavy dependency).
- **Accept when:** The licence/terms review concludes this is acceptable.
- **Evidence update (2026-11-08, `docs/context.md` §12):** The spike implemented the documented flow from the public docs alone (no DevKit code used or read) in about 200 lines with Node built-ins, which shows technical feasibility. The licence/terms question is unresolved. **Status: accepted for implementation by the owner's Phase 3 instruction (2026-11-08); the product implements the protocol in Rust without the DevKit; licence/terms review still open.**

### ADR-0009 (proposed): Provider abstraction with separate auth, role and capability interfaces
- **Date proposed:** 2026-11-08
- **Context:** See `docs/ARCHITECTURE.md` §6a.
- **Proposed decision:** Two provider roles (Reasoner for prompt engineering, Executor for task execution), a separate auth interface, a shared error taxonomy, and a registry, so new providers (for example DeepSeek) are adapters only.
- **Alternatives considered:** One universal "Agent" interface (the earlier sketch), which mixes streaming chat with long-running tool-using jobs and forces a lowest-common-denominator design.
- **Accept when:** The user reviews it and it is validated against both real adapters in Phase 3.
- **Status (2026-11-08):** implemented in Phase 3 as the smallest boundary that works (separate Rust modules `chatgpt` for the Reasoner and `claude` for the Executor, a shared error taxonomy); no registry or plugin system. Accepted for implementation by the owner's Phase 3 instruction.

### ADR-0012 amendment A (ACCEPTED 2026-11-08 — moved to ADR-0012 below)
- **Date proposed:** 2026-11-08 (Phase 2 measurement gate, `docs/ARCHITECTURE.md` §13)
- **Context:** ADR-0012 asks to document evidence and propose a revised target when a target proves unrealistic. The gate measured the RAM targets as literally defined (sum of working sets of the process tree) at 371 MB idle and 377 MB active, against 180/260 MB targets and 250/350 MB limits. A **blank** Tauri + WebView2 page, with no Pixi at all, already sums to 355 MB, because the seven WebView2 processes share most of their pages. By **private** working set the same measurements are 84 MB (blank), 90 MB (idle) and 96 MB (active). So the targets cannot be met by any application on this stack with this metric, while the actual memory the app adds is small.
- **Proposed change (measurements are on one machine, three runs per state):**
  1. Make **private working set of the Mushoku Guild process tree** the memory budget metric. Always report the summed working set next to it for transparency.
  2. Proposed private-working-set targets, set with headroom over the measured values and to be re-checked with real providers, SQLite and art: idle ≤ 120 MB (limit 150 MB), active ≤ 140 MB (limit 180 MB). These are proposals derived from 84/90/96 MB measured; they are not requirements met.
  3. Keep every other ADR-0012 number unchanged: all of them were met (or are still unmeasured, see below).
  4. Add two design rules found by measurement: **no `requestAnimationFrame` loop in idle states** (use timers that fire only when something changes) and **all renderer tickers stopped when the window is minimised** (the Rust core publishes window state because WebView2 does not).
  5. Keep these as explicitly **open** metrics, to be measured when the pieces exist: memory growth over 8 hours, idle disk writes, visible-but-unfocused CPU, first-ever-launch start-up.
- **Alternatives considered:** Keep the literal metric and fail the gate (a pass is impossible on this stack, so it would only block work); count only the app and renderer processes (arbitrary, hides real memory); use "commit" or "private bytes" (not measured here; private working set was available and comparable to Task Manager's "active private working set").
- **Consequences if accepted:** the gate for memory becomes meaningful; the stack decision (ADR-0010) stands; ADR-0012 is edited to record the amendment (never silently).
- **Status:** **accepted by the owner on 2026-11-08** (Phase 3 instruction): private working set is the memory metric; targets 120 MB idle and 140 MB active. The limits (150/180 MB) proposed above were not mentioned by the owner and are kept as the hard limits.

### Other candidate decisions (not yet drafted)
- Credential storage mechanism (Windows Credential Manager vs protected file).
- Approval model granularity (prompt approval, run approval, per-tool approval via an MCP prompt tool).
- Project licence for Mushoku Guild (affects any use of OpenAI DevKit code).

### ADR-0013 (accepted 2026-11-09, owner's Cycle 5 instruction): Atmosphere, attachments and Universal Chat
- **Café atmosphere:** four dayparts from the LOCAL clock (05-11 morning, 11-16 noon, 16-19 evening, 19-05 night) or a manual choice, both stored in the `settings` table (`cafe_mode`, `cafe_theme`). Implemented as an extra Pixi layer (outdoor scenery behind transparent window glass, shade wash, light beams, lamp glows, tints) cross-faded in about 1.4 s by the existing timer; no new loop, no scene rebuild, characters untouched.
- **Quest attachments:** files are validated by Rust (extension allow-list, magic bytes, size/count limits), copied to `<data>/attachments/<project>/<quest>/<id>.<ext>` and recorded in `task_attachments`. Images and PDFs reach Claude as `image`/`document` content blocks of the stream-json user message (verified against the real CLI, test `real_claude_sees_the_attached_image_pdf_and_text`); text is inlined as capped DATA. A manifest is appended to the approved prompt at run time. They grant no permissions. The main window sets `dragDropEnabled: false` so HTML5 drag and drop reaches the page.
- **Universal Chat:** global tables `uchat_conversations` / `uchat_messages` with no project column; one provider per conversation. ChatGPT mode reuses the existing OAuth and model setting unchanged. Claude mode runs the installed CLI with `--tools ""`, `--setting-sources ""`, no MCP, in an empty scratch folder, one turn, history replayed as a transcript (no session files). A separate opt-in read-only research capability was NOT built; Claude chat is conversation only.
- **Library search:** client-side filter over the already-listed document metadata; no disk scan per keystroke.

### ADR-0014 (accepted 2026-11-09, owner's Cycle 6 instruction): renderer recovery, idle dialogue, To-Do, responsive Library
- **Renderer recovery:** a tiny pure health state machine (`domain/renderHealth.ts`) drives recovery. Lost WebGL contexts wait for the browser's restore; failures rebuild only the Pixi scene (at most twice a minute), then the UI shows a fallback with Retry. The whole application is never reloaded.
- **Idle dialogue:** local data and a deterministic director (`domain/idle.ts`); the module imports nothing from the IPC layer (test-enforced). Zero network or AI use.
- **To-Do:** own SQLite table `todos` (migration 5), repository tag `ON DELETE SET NULL`; separate from quests.
- **Library:** logical view size follows the container (`fitView`); only the layout is recomputed on resize.
- **Provider research:** `docs/MULTI_MODEL_PROVIDER_RESEARCH.md` recommends a Rust generic OpenAI-compatible adapter; no SDK or Node runtime.
