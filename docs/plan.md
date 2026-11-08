# plan.md — Development Plan & Progress (Single Source of Truth)

## Rules

1. Never mark a task complete without verifying it.
2. Update this file immediately after meaningful work.
3. Completed tasks stay recorded as completed; history is never silently deleted.
4. Obsolete tasks are removed only with justification, recorded in the Change log below.
5. Do not start a later phase while mandatory dependencies remain incomplete.
6. Status values: `planned` · `in-progress` · `blocked` · `completed`.
7. Tasks are granular and actionable. Phase 2 is detailed; Phases 3+ remain **provisional** and are refined after the Phase 2 gate.

## Phase overview

| # | Phase | Status |
|---|-------|--------|
| 0 | Repository initialisation & governance | completed |
| 1 | Discovery & feasibility | completed |
| 2 | Foundation (project skeleton, tooling, CI) | prepared — starts only on the user's explicit instruction |
| 3 | MVP — headless orchestration core + real agent integration | planned |
| 4 | MVP — presentation layer (café v1) | planned |
| 5 | Integration hardening | planned |
| 6 | Polish | planned |
| 7 | Release | planned |

---

## Phase 0 — Repository initialisation & governance

- **Status:** completed
- **Objective:** Establish the repository and the documentation/governance foundation.
- **Deliverables:** GitHub repo with `main`; `CLAUDE.md`, `docs/context.md`, `docs/DECISIONS.md`, `docs/architecture.md`, `docs/system-design.md`, `docs/plan.md`.
- **Dependencies:** None.
- **Tasks:**
  - [x] Inspect directory and Git state (empty directory, no repo)
  - [x] `git init`, set `origin` to the GitHub URL, branch `main`
  - [x] Create initial commit (`.gitignore`) and push; verified `origin/main` set up
  - [x] Write `CLAUDE.md`
  - [x] Write `docs/context.md`
  - [x] Write `docs/DECISIONS.md`
  - [x] Write `docs/architecture.md`
  - [x] Write `docs/system-design.md`
  - [x] Write `docs/plan.md`
  - [x] Commit and push documentation; verified remote `main` = local HEAD (823d1bb) and lists all six files
- **Acceptance criteria:** Remote `main` contains all six documents; documents are mutually consistent; no application code exists.
- **Testing requirements:** Compare local `HEAD` with `origin/main`; re-read documents for contradictions.

---

## Phase 1 — Discovery & feasibility

- **Status:** completed (2026-11-08; closed on the user's approval of ADR-0010, ADR-0011 and ADR-0012; carried-forward items are listed in the closure note below)
- **Objective:** Answer the open questions in `docs/context.md` §8 and choose a stack with evidence.
- **Deliverables:** Written stack trade-off evaluation; integration research and spike findings (`docs/context.md` §11); accepted ADRs; MVP scope definition; resource budgets.
- **Dependencies:** Phase 0 complete; user available for scope questions and for running the ChatGPT authorization test with their own account.
- **Tasks:**
  - [x] Research the Sign in with ChatGPT open-source integration from official docs (OAuth/PKCE, host ID, tokens, models, Responses limits, errors, UI rules) → `docs/context.md` §11.1
  - [x] Research DevKit availability and licence → noncommercial licence found (§11.1)
  - [x] Research Claude Code headless CLI (flags, streaming, permissions, auth, sessions) from official docs → §11.2
  - [x] Research Anthropic policy on subscription use by third-party apps → §11.3
  - [x] Verify locally that `claude -p --output-format stream-json` runs under the existing subscription login and emits the documented event types (trivial prompt; exit 0)
  - [x] Propose provider abstraction (ADR-0009, proposed) and record accepted ADR-0006
  - [x] **Run a ChatGPT authorization test with the user's account** (throwaway spike `spikes/chatgpt-siwc/`): registration, auth, token exchange, ID-token validation, scope check, `/v1/models` (3 listed models) and one streamed response all succeeded on 2026-11-08 (`docs/context.md` §12). Caveat: plan type is not visible in tokens; Go is the user's statement
  - [ ] User confirms in ChatGPT Settings that the tested account's plan is Go
  - [ ] Ask OpenAI (or fetch the help-center article that returned 403) to confirm Go eligibility for open-source plan usage (docs still name only Plus/Pro)
  - [ ] Disconnect the spike's "Mushoku Guild" grant in ChatGPT Settings (the spike did not revoke its refresh token)
  - [ ] Extend the spike or a second spike to test: refresh-token rotation, revocation, reauthorization with `id_token_hint`, `instructions`, multi-turn input, mid-stream failure and usage-limit errors, response headers for quota information
  - [ ] Decide what happens to `spikes/chatgpt-siwc/` (committed 2026-11-08 as disposable research evidence with READMEs saying so; delete `spikes/` when Phase 1 concludes or when the real implementation replaces it; never import it into application code)
  - [ ] Review the DevKit licence and OpenAI terms for an open-source app that implements the flow itself; choose the project licence
  - [ ] Put the CLI-spawning pattern to Anthropic (contact link on the legal page) and record the answer
  - [x] Spike Claude Code on a real edit task (`spikes/claude-cli/`, 2026-11-08): discovery, version/signature/auth checks, launch with scrubbed env, real `tool_use`/`tool_result`/`permission_denied` events, `--permission-prompt-tool` contract, process-tree cancellation and graceful interrupt on Windows, exit codes observed, login retained across 8 runs (`docs/context.md` §13). Not covered: Rust launcher, Ctrl+C console events, Job Objects, error paths (expired login, usage limit, max turns/budget), machines without Git, long-lived multi-turn process
  - [x] Measure the per-run overhead of the user's global Claude config: ~110k cache tokens/$0.44 with full config vs ~13.6k tokens/$0.0009 with `--strict-mcp-config`, slash commands and user settings disabled; ~200–285 MB RAM per run tree (`docs/context.md` §13.8). Mitigation direction only; not a decision
  - [ ] Test Claude Code error paths without touching the login: usage-limit and max-turns/budget results, `--permission-prompts none`, approver timeout/crash behaviour, `api_retry` events
  - [ ] Measure idle cost and behaviour of a long-lived stream-json Claude process vs one process per task; decide process model
  - [ ] Verify Claude Code on a Windows machine without Git for Windows (Bash tool / PowerShell fallback) and with paths containing spaces
  - [ ] Decide whether the app honours the user's global Claude settings, plugins and hooks or runs with `--setting-sources project,local`; always use `--strict-mcp-config` (candidate requirement)
  - [ ] Clarify with the user: MVP scope, target platforms, approval model, persistence needs, fallback if Go is ineligible
  - [x] Evaluate candidate UI/runtime/rendering stacks against the constraints on paper (`docs/architecture.md` §11; docs-based, no measurements)
  - [ ] Measure idle CPU/RAM of a Tauri + Pixi hello-world — **deferred to Phase 2 task 2.3/2.6 (measurement gate)**; requires the Rust/MSVC toolchain, which is not installed
  - [x] Decide stack → ADR-0010 accepted by the user (2026-11-08)
  - [x] Draft resource budgets v0 (`docs/architecture.md` §9) and user accepts them as **provisional engineering targets** (ADR-0012, 2026-11-08) — targets, not measurements
  - [ ] Confirm budgets from a measured baseline — carried forward to Phase 2 task 2.6 (measure, do not assume; Claude CLI usage measured separately)
  - [x] Draft MVP scope (`docs/context.md` §14) and persistence/IPC design (`docs/system-design.md` §2.16–2.17)
  - [x] User approves the MVP scope (ADR-0011 accepted 2026-11-08)
  - [ ] Decide on ADR-0007, ADR-0008 and ADR-0009 (accept, change or reject) — **carried forward; required before Phase 3 starts**
  - [x] Classify remaining questions into development blockers vs release blockers (`docs/context.md` §15)
  - [x] Refine Phase 2 into a detailed proposed plan (below); Phases 3–7 remain provisional until Phase 2's gate
  - [x] User reviews and approves Phase 1 closure (2026-11-08)
- **Acceptance criteria:** Stack ADR `accepted`; both integration routes either proven by a spike or explicitly rejected/replaced (ChatGPT Go result known); licence position recorded; MVP scope written and agreed.
- **Testing requirements:** Spikes are run for real; results (including failures) recorded verbatim in notes; measurements reproducible.


**Phase 1 closure note (2026-11-08).** The user approved ADR-0010 (stack), ADR-0011 (MVP scope) and ADR-0012 (provisional budgets) and asked for Phase 1 to be marked completed. Assessment against the acceptance criteria above:
- Stack ADR `accepted` — **met** (ADR-0010).
- Both integration routes proven by a spike — **met** (ChatGPT: end-to-end success, Go plan identity per the user's statement and not confirmed in writing by OpenAI; Claude CLI: end-to-end success on CLI 2.1.319).
- Licence position recorded — **recorded as an open release blocker, not resolved** (see the register below).
- MVP scope written and agreed — **met** (ADR-0011).

Phase 1 tasks left unticked above were **not completed**; they are carried forward, not dropped:
- Measure a Tauri + Pixi baseline and confirm budgets → Phase 2 tasks 2.3 and 2.6.
- Decide ADR-0007, ADR-0008, ADR-0009 → required before Phase 3 starts.
- Ask OpenAI to confirm Go eligibility; review licence and terms; put the CLI-spawning question to Anthropic; extra ChatGPT and Claude CLI test coverage; Claude settings policy; clarifications on approval model/persistence/fallback → the register below and `docs/context.md` §15.
- Remove or keep `spikes/` → decided at the end of Phase 3 or when the real adapters replace them.

## Phase 2 — Foundation (prepared; NOT started — begins only on the user's explicit instruction)

- **Status:** planned — ready to start; awaiting the user's explicit go
- **Objective:** Create a buildable, linted, tested Tauri skeleton and prove it meets the resource budgets **before** any feature work. This phase contains no product features.
- **Deliverables:** Installed toolchain; Tauri 2 + Rust + TypeScript/React + PixiJS skeleton; formatter, linter, test runners; CI; a measurement harness and a recorded baseline; the gate decision (confirm or revise ADR-0010/0012); updated `CLAUDE.md` coding standards.
- **Dependencies:** Phase 1 completed (met 2026-11-08); ADR-0010, ADR-0011 and ADR-0012 accepted (met); Rust/MSVC toolchain installed (task 2.0, **not yet met**); the user's explicit start instruction (**not yet given**).
- **Prepared start procedure (awaiting the user's explicit instruction to begin; nothing below has been run):**
  1. **User actions needed:** install Rust (MSVC host) via `rustup` and the Microsoft C++ Build Tools ("Desktop development with C++") — Claude Code can do this on request but the installs are large and touch the system, so they need the user's go-ahead; confirm WebView2 runtime is present (157.0.4341.42 detected).
  2. **Task order:** 2.0 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 (gate) → only then 2.7 → 2.8 → 2.9 → 2.10. Tasks 2.7–2.10 must not start before the gate result is reported to the user.
  3. **Rules for the gate:** measure, do not assume; record method, environment and raw numbers; measure the Mushoku Guild process tree separately from any `claude.exe` activity; stability and security are never traded for a number; if a target looks unrealistic, document the evidence and propose a revised target (ADR-0012 amendment) for approval.
  4. **Pinning:** record exact Rust, Node, Tauri, PixiJS and rusqlite versions used; the Tauri 2 plugins documented in Phase 1 require a recent Rust (1.90+ per the Tauri docs).
  5. **Commit discipline:** one logical commit per task group, Conventional Commits, no commit/push without the user's authorisation for that session; docs and `plan.md` updated with each task.
  6. **Out of scope for Phase 2:** providers, OAuth, Claude CLI integration, SQLite schema, real café art, the approval flow. The skeleton may contain only placeholders needed for the measurements.
- **Tasks:**
  - [ ] **2.0 Toolchain:** install Rust (MSVC toolchain, pinned version) and Microsoft C++ Build Tools on the dev machine; verify WebView2 runtime; record versions in `docs/architecture.md`
  - [ ] **2.1 Walking skeleton:** `create-tauri-app`-style scaffold (Tauri 2, TypeScript, React, Vite), a single window, one Rust command, one Channel stream; no business logic
  - [ ] **2.2 Scene spike:** minimal PixiJS WebGL scene (a few animated sprites on a spritesheet, ticker stop/start, `maxFPS`, `powerPreference: 'low-power'`); verify AnimatedSprite and render-on-demand behave as expected (docs gap)
  - [ ] **2.3 Measurement harness:** script to launch the app and sample the process tree (RAM, CPU, process count, startup time) for idle-focused, idle-hidden/minimised, and scripted-active states; repeat 3×; store results in `docs/` as a table
  - [ ] **2.4 Hidden-window behaviour:** test what Tauri/WebView2 does when the window is minimised or hidden; try ticker stop; test whether WebView2 `TrySuspend`/`MemoryUsageTargetLevel` are reachable from Tauri; record findings
  - [ ] **2.5 Hybrid-GPU check:** observe which GPU the WebView2 GPU process uses on this laptop and the effect of Windows graphics settings
  - [ ] **2.6 Gate:** compare measurements with the ADR-0012 provisional targets; record method, environment and raw numbers; report the Mushoku Guild process tree separately from any `claude.exe` activity. If targets are met, record the baseline. If a target is unrealistic, document the evidence and propose a revised target (an ADR-0012 amendment) to the user. If the stack cannot meet the needs without compromising stability or security, report it and evaluate the .NET + Skia fallback. Do not continue past the gate without the user's decision
  - [ ] **2.7 Tooling:** rustfmt + clippy (deny warnings), Prettier/ESLint, TypeScript strict, Vitest, `cargo test`; one example test per side; `cargo audit` and `npm audit` wired in
  - [ ] **2.8 Tauri security baseline:** minimal capabilities, strict CSP, no frontend shell/fs/SQL permissions, single-instance plugin; written down in `docs/architecture.md`
  - [ ] **2.9 CI:** Windows runner builds, lints, tests, produces an NSIS installer artifact; fresh-clone build instructions verified
  - [ ] **2.10 Docs:** update `CLAUDE.md` §5 (stack-specific standards and commands), `docs/architecture.md` (versions, layout), and ADR statuses
- **Acceptance criteria:** A fresh clone builds, lints and tests from documented commands; CI is green; the skeleton runs on the reference laptop; baseline measurements are recorded; the gate decision is recorded and approved by the user; no feature code exists.
- **Testing requirements:** Measurement runs are repeatable and recorded verbatim (including failures); lint and tests pass; installer artifact installs and uninstalls cleanly on the dev machine.

## Phase 3 — MVP: headless orchestration core + real agent integration (provisional)

- **Status:** planned
- **Objective:** A working task pipeline with approval gates and real agents, usable without the café UI.
- **Deliverables:** Event bus, task state machine, approval gate, Agent adapter interface, working Claude Code adapter, working prompt-agent adapter, minimal persistence (if confirmed).
- **Dependencies:** Phase 2 gate passed; ADR-0007, ADR-0008, ADR-0009 decided; project licence and credential-storage decisions (`docs/context.md` §15.2).
- **Tasks:**
  - [ ] Implement event types and bus
  - [ ] Implement task state machine with unit tests
  - [ ] Implement approval gate with unit tests
  - [ ] Define adapter interface; implement fake agent for tests
  - [ ] Implement Claude Code adapter
  - [ ] Implement prompt-agent adapter
  - [ ] Wire the end-to-end pipeline: describe → prompt → approve → execute → result
  - [ ] Cancellation and failure handling; child-process cleanup
  - [ ] Config and secret handling
- **Acceptance criteria:** A real task runs end-to-end through real agents with user approval, from a minimal interface; failures are surfaced; no orphan processes.
- **Testing requirements:** Unit tests for core; adapter contract tests; at least one verified real end-to-end run recorded.

## Phase 4 — MVP: presentation layer, café v1 (provisional)

- **Status:** planned
- **Objective:** Present agents/tasks as a café scene driven by the real event stream.
- **Deliverables:** Scene with agent characters and orders, status display, approval and review UI, plain-text activity view.
- **Dependencies:** Phase 3; art direction/asset decisions from Phase 1.
- **Tasks:**
  - [ ] Implement UI shell and task creation/approval/review screens
  - [ ] Implement event-to-scene state projection
  - [ ] Implement café renderer v1 (scope per MVP definition)
  - [ ] Throttle rendering when unfocused/hidden
  - [ ] Activity log view (accessible text equivalent of the scene)
- **Acceptance criteria:** User can run a full task via the UI; scene reflects real agent state; resource use within budget.
- **Testing requirements:** UI flows exercised manually or automated; CPU/RAM measured idle and active against budgets.

## Phase 5 — Integration hardening (provisional)

- **Status:** planned
- **Objective:** Make integrations robust.
- **Dependencies:** Phases 3–4.
- **Tasks:**
  - [ ] Retry/backoff for transient errors
  - [ ] Handle agent crashes, timeouts, malformed output
  - [ ] Secrets redaction in logs
  - [ ] Verify extensibility by adding a second agent adapter (or a documented stub) without core changes
- **Acceptance criteria:** Failure scenarios tested; second adapter integrates cleanly.
- **Testing requirements:** Fault-injection tests; real-agent runs.

## Phase 6 — Polish (provisional)

- **Status:** planned
- **Objective:** Improve experience and performance.
- **Dependencies:** Phase 5.
- **Tasks:**
  - [ ] Animation/visual refinement within budget
  - [ ] Accessibility pass
  - [ ] Performance profiling and fixes
  - [ ] Onboarding / settings UX
- **Acceptance criteria:** Meets resource budgets and usability review.
- **Testing requirements:** Re-measure budgets; usability walkthrough.

## Phase 7 — Release (provisional)

- **Status:** planned
- **Objective:** Package and publish.
- **Dependencies:** Phase 6; distribution decisions.
- **Tasks:**
  - [ ] Installer/packaging
  - [ ] User documentation and README
  - [ ] License and asset-licensing review
  - [ ] Release process and versioning
- **Acceptance criteria:** Installable build verified on a clean machine.
- **Testing requirements:** Clean-machine install test.

---

## Release blockers register (carried forward; none cleared by the ADR-0010/0011/0012 approvals)

These must be resolved before any public distribution. They do not block starting Phase 2 or Phase 3 unless stated in `docs/context.md` §15. Details and sources: `docs/context.md` §11–§15.

- [ ] **OpenAI preview terms and licensing:** the integration is a documented preview whose availability, eligibility and terms may change; review OpenAI terms, brand/UI requirements and distribution conditions for an open-source app; the DevKit is under a **noncommercial** licence (do not copy its code unless the licence fits; ADR-0008 stays proposed); choose Mushoku Guild's own source licence
- [ ] **ChatGPT Go eligibility in writing:** observed to work in one spike, plan identity per the user's statement; OpenAI docs name only Plus and Pro; do not claim Go support publicly until OpenAI confirms
- [ ] **Anthropic CLI/subscription policy:** obtain Anthropic's answer on launching `claude -p` locally under a user's subscription; keep ADR-0006 constraints; decide the fallback (API-key Executor adapter) if unfavourable
- [ ] **ChatGPT authorisation lifecycle verified:** refresh-token rotation, revocation, reauthorisation with `id_token_hint`, usage-limit and ineligibility errors, mid-stream failures
- [ ] **Claude CLI robustness verified:** error paths (expired login, usage limit, max turns/budget, approver timeout/crash), version-compatibility matrix and a pinned minimum version, behaviour without Git for Windows, guaranteed process cleanup
- [ ] **Windows trust:** code signing, SmartScreen and Smart App Control behaviour; WebView2 runtime handling
- [ ] **Production security baseline** (`docs/context.md` §15.5) implemented and reviewed, including credential storage, Tauri least privilege and CSP, authenticated approver bridge, and data-retention controls
- [ ] **Legal hygiene:** third-party licence inventory, art/asset licences, privacy statement (prompts and outputs go to OpenAI and Anthropic and are stored locally)
- [ ] **Measured budgets:** ADR-0012 targets measured on the reference laptop and any revisions recorded with evidence

## Change log

- 2026-11-08 — Plan created during repository initialisation. Phase 0 completed and verified on remote.
- 2026-11-08 — Documentation moved from repository root to `docs/` (ADR-0005); `CLAUDE.md` remains in root. Phase 0 status unchanged (completed). Task names above refer to the files by their original creation.
- 2026-11-08 — Phase 1 started. Integration research completed and documented; Phase 1 tasks refined (added Go authorization test, licence review, Anthropic policy query, Claude Code spike, overhead measurement). No tasks removed.
- 2026-11-08 — ChatGPT authorization spike run and documented (`docs/context.md` §12). Go-test task ticked with caveats; new follow-up tasks added (plan confirmation, grant cleanup, extended tests, spike disposal). ADR-0007/0008 remain proposed. No tasks removed.
- 2026-11-08 — Native Windows Claude Code CLI spike run and documented (`docs/context.md` §13). Two Phase 1 tasks ticked with caveats; four follow-up tasks added. No tasks removed. No ADRs changed (ADR-0006 stands; nothing new accepted).
- 2026-11-08 — Phase 1 closure proposals added: stack evaluation, MVP scope, resource budgets, blocker classification, detailed Phase 2 plan. ADR-0010/0011/0012 drafted as `proposed`. Phase 1 marked ready to close pending user approval; the measured-baseline items moved to the Phase 2 gate rather than being claimed. No tasks removed; Phase 2 task list was replaced by a more detailed one (the old provisional list was: scaffold, tooling, CI, empty window, baseline measurement; all are covered by tasks 2.1–2.9).
- 2026-11-08 — User accepted ADR-0010, ADR-0011 and ADR-0012 (the latter as provisional targets with binding qualifications). Phase 1 marked completed with an explicit closure note; unticked Phase 1 tasks carried forward (not dropped) to Phase 2, Phase 3 and the new release blockers register. Phase 2 prepared (start procedure, ordering and gate rules) but not started. ADR-0007, ADR-0008 and ADR-0009 remain proposed. No tasks removed.
