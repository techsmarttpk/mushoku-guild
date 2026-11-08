# plan.md — Development Plan & Progress (Single Source of Truth)

## Rules

1. Never mark a task complete without verifying it.
2. Update this file immediately after meaningful work.
3. Completed tasks stay recorded as completed; history is never silently deleted.
4. Obsolete tasks are removed only with justification, recorded in the Change log below.
5. Do not start a later phase while mandatory dependencies remain incomplete.
6. Status values: `planned` · `in-progress` · `blocked` · `completed`.
7. Tasks are granular and actionable. Phases 2+ are **provisional** and will be refined when Discovery produces real answers (stack, integration routes).

## Phase overview

| # | Phase | Status |
|---|-------|--------|
| 0 | Repository initialisation & governance | completed |
| 1 | Discovery & feasibility | in-progress |
| 2 | Foundation (project skeleton, tooling, CI) | planned |
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

- **Status:** in-progress (research done 2026-11-08; tests, licence review and stack decision outstanding)
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
  - [ ] **Run a ChatGPT authorization test with the user's Go account** (throwaway spike: registration, token exchange, scope check, `/v1/models`, one streamed response); record success or the exact error. Until done, Go eligibility stays **unconfirmed**
  - [ ] Ask OpenAI (or fetch the help-center article that returned 403) to confirm Go eligibility for open-source plan usage
  - [ ] Review the DevKit licence and OpenAI terms for an open-source app that implements the flow itself; choose the project licence
  - [ ] Put the CLI-spawning pattern to Anthropic (contact link on the legal page) and record the answer
  - [ ] Spike Claude Code on a real edit task: real `tool_use`/`tool_result` events, `--permission-prompt-tool` contract, `permission_denied` handling, cancellation and process cleanup on Windows, numeric exit codes
  - [ ] Measure the per-run overhead of the user's global Claude config (about 110k cache tokens observed) and decide how to mitigate it
  - [ ] Clarify with the user: MVP scope, target platforms, approval model, persistence needs, fallback if Go is ineligible
  - [ ] Evaluate candidate UI/runtime/rendering stacks against constraints; measure idle CPU/RAM for a hello-world of each shortlisted option
  - [ ] Decide stack → ADR (needs user agreement)
  - [ ] Set resource budgets from measured baselines → record in `docs/architecture.md`
  - [ ] Define MVP scope and update `docs/context.md`, `docs/system-design.md`
  - [ ] Decide on ADR-0007, ADR-0008 and ADR-0009 (accept, change or reject)
  - [ ] Reconcile and refine Phases 2–7 of this plan
- **Acceptance criteria:** Stack ADR `accepted`; both integration routes either proven by a spike or explicitly rejected/replaced (ChatGPT Go result known); licence position recorded; MVP scope written and agreed.
- **Testing requirements:** Spikes are run for real; results (including failures) recorded verbatim in notes; measurements reproducible.

## Phase 2 — Foundation (provisional)

- **Status:** planned
- **Objective:** Create a buildable, tested, linted project skeleton in the chosen stack.
- **Deliverables:** Project scaffold, formatter/linter, test runner, CI, build/run docs.
- **Dependencies:** Phase 1 acceptance criteria met.
- **Tasks:**
  - [ ] Scaffold the project per the accepted stack
  - [ ] Add formatter, linter, test runner; document commands in `CLAUDE.md`
  - [ ] Add CI running lint + tests
  - [ ] Add empty app window that builds and launches
  - [ ] Measure and record baseline idle CPU/RAM
- **Acceptance criteria:** Clean checkout builds, lints and tests from documented commands; CI green; baseline recorded.
- **Testing requirements:** Fresh-clone build verified.

## Phase 3 — MVP: headless orchestration core + real agent integration (provisional)

- **Status:** planned
- **Objective:** A working task pipeline with approval gates and real agents, usable without the café UI.
- **Deliverables:** Event bus, task state machine, approval gate, Agent adapter interface, working Claude Code adapter, working prompt-agent adapter, minimal persistence (if confirmed).
- **Dependencies:** Phase 2; Phase 1 integration findings.
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

## Change log

- 2026-11-08 — Plan created during repository initialisation. Phase 0 completed and verified on remote.
- 2026-11-08 — Documentation moved from repository root to `docs/` (ADR-0005); `CLAUDE.md` remains in root. Phase 0 status unchanged (completed). Task names above refer to the files by their original creation.
- 2026-11-08 — Phase 1 started. Integration research completed and documented; Phase 1 tasks refined (added Go authorization test, licence review, Anthropic policy query, Claude Code spike, overhead measurement). No tasks removed.
