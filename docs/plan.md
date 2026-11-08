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
| 2 | Foundation (project skeleton, tooling, CI) | in progress (2.0–2.6 complete, gate awaiting review; 2.7–2.10 on hold) |
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

## Phase 2 — Foundation (in progress; 2.0–2.6 complete, gate awaiting the user's review; 2.7–2.10 on hold)

- **Status:** in-progress — tasks 2.0–2.6 complete and verified (2026-11-08); **2.7–2.10 not started and on hold until the user reviews the measurement gate**
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
  - [x] **2.0 Toolchain** (verified 2026-11-08): Rust 1.99.1 stable (MSVC host) via rustup under `D:\toolchains` (installer SHA-256 matched Rust's published checksum); Microsoft C++ Build Tools 17.14 with only `VC.Tools.x86.x64` (MSVC 14.44.35207) and `Windows11SDK.22621` (SDK 10.0.22621.5040 at `D:\Windows Kits\10`), installed from Microsoft's signed bootstrapper; WebView2 runtime 157.0.4341.42 present. A scratch `cargo build` linked and ran a program through the MSVC linker. **Known issue:** the Visual Studio instance registration did not land in the standard `C:\ProgramData` location (my temporary cache-path policy put it on `D:`), so `rustc`/`vswhere` do not auto-discover the tools; builds currently run inside the VS developer environment (`vcvars64.bat`). An elevated one-line repair is documented in `docs/architecture.md` §12 and was declined/cancelled once; it is optional. Details: `docs/architecture.md` §12
  - [x] **2.1 Walking skeleton** (verified 2026-11-08): Tauri 2.12.5 + Rust core (`src-tauri/`, one product command `app_info`, plus Phase 2 measurement fixtures in `bench.rs`), React 19.3.1 + TypeScript 7.0.2 strict + Vite 8.3.6 frontend (`src/`), single 960x640 window, one ordered Tauri Channel stream. Evidence: `tsc --noEmit` clean; `pnpm build` ok; `cargo build` (debug, 8 m 09 s cold) ok with no warnings; debug exe run against the Vite dev server: command call returned, 2,700 channel events at 60 Hz arrived with 0 gaps (core-to-UI latency p50 0.78 ms, p95 1.66 ms, max 25.6 ms; debug build, one run, same-machine clocks so about 1 ms uncertainty). Frontend has no shell, filesystem or SQL access; capability is `core:default` only. Decision note: the app is a dependency-minimal skeleton; a dependency/feature audit of the 403-crate lockfile is deferred to task 2.7/2.8
  - [x] **2.2 Scene spike** (verified 2026-11-08): PixiJS 8.22.0 WebGL scene built from vector primitives (no asset files), two animated characters, an order board and a moving ticket; kept outside React (React only creates/destroys the controller). Verified: renderer reported as `webgl`; `AnimatedSprite` stepped explicitly (`autoUpdate=false`); render-on-demand works (ambient: 2.91 steps and 2.91 draws per second; active: 29.55 per second; stopped: 0); `ticker.stop()`/`start()`/`maxFPS` behave as documented but **the shared ticker is not the whole story**: Pixi's internal `Ticker.system` also polls on rAF and costs ~1.7% CPU, and no rAF loop is cheap at any `maxFPS`, so idle animation is timer-driven (`docs/architecture.md` §13.3 F2/F3). `powerPreference: 'low-power'` did not select the integrated GPU (F5)
  - [x] **2.3 Measurement harness** (verified 2026-11-08): `tools/measure/` (`measure.mjs`, `sampler.ps1`, `window.ps1`; no dependencies) measures startup, RAM (summed and private working set), total-machine CPU, process count, scene step/draw rates, event latency and GPU engines for the app's process tree, 3 runs per scenario; installer size from the build output and a real silent install/uninstall. Results and caveats: `docs/measurements/phase2/` and `docs/architecture.md` §13. Harness limits: cannot reliably change OS focus, so visible-but-unfocused is unmeasured; no soak test; no disk-write counters
  - [x] **2.4 Hidden-window behaviour** (verified 2026-11-08): WebView2 does **not** report minimise or `SW_HIDE` to the page (`document.hidden` stays false; the page keeps animating); fixed for minimise with a Rust-published `window-minimized` event (frames frozen while minimised, resume on restore; CPU 0.051%); an externally hidden window cannot be detected (0.33% with timer animation); WebView2 does not trim memory by itself when minimised. `TrySuspend`/`MemoryUsageTargetLevel` are reachable (`with_webview` → `ICoreWebView2Controller`; bindings present in `webview2-com`) but were **not exercised** because that needs a direct dependency; no CPU target needs them
  - [x] **2.5 Hybrid-GPU check** (verified 2026-11-08): WebView2's GPU process uses the discrete **GTX 1650** by default (all engine instances on LUID `…16CE6`, Intel never touched) with ~0% utilisation in idle, minimised and active states. Temporarily setting the Windows graphics preference of the WebView2 runtime to power saving (then restored to "none" and checked) moved work to the Intel UHD, did not change CPU, raised private memory from ~93 to ~118 MB and slowed startup slightly. Conclusion: keep the default, no GPU-preference hack
  - [x] **2.6 Gate** (assessment done 2026-11-08; **the user's decision on its outcome is still required before 2.7**): all measured budgets met except the two RAM rows as literally defined (sum of working sets: 371/377 MB vs 180/260 MB; a blank WebView2 page already sums to 355 MB, private working set is 84 MB blank / 90 idle / 96 active). Proposed ADR-0012 amendment A (metric = private working set) is in `docs/DECISIONS.md`, **not accepted**. Open/unmeasured: 8-hour memory growth, idle disk writes, visible-but-unfocused CPU, first-ever-launch start-up. No evidence calls for the .NET + Skia fallback. Full table: `docs/architecture.md` §13
  - [ ] **2.7 Tooling:** rustfmt + clippy (deny warnings), Prettier/ESLint, TypeScript strict, Vitest, `cargo test`; one example test per side; `cargo audit` and `npm audit` wired in
  - [ ] **2.8 Tauri security baseline:** minimal capabilities, strict CSP, no frontend shell/fs/SQL permissions, single-instance plugin; written down in `docs/architecture.md`
  - [ ] **2.9 CI:** Windows runner builds, lints, tests, produces an NSIS installer artifact; fresh-clone build instructions verified
  - [ ] **2.10 Docs:** update `CLAUDE.md` §5 (stack-specific standards and commands), `docs/architecture.md` (versions, layout), and ADR statuses
- **Carried forward from tasks 2.0–2.6 (not done, not dropped):**
  - [ ] Remove or gate behind a Cargo feature the Phase 2 measurement fixtures (`src-tauri/src/bench.rs`, `src/bench.ts`, the `bench_*` commands) before Phase 3 starts
  - [ ] Measure memory growth over a multi-hour soak and idle disk writes (needs a long run; not done in Phase 2)
  - [ ] Measure the visible-but-unfocused state once window focus can be controlled reliably; measure first-ever-launch start-up
  - [ ] Optionally exercise WebView2 `TrySuspend`/`MemoryUsageTargetLevel` (reachable; needs a direct `webview2-com` dependency, so it needs its own justification)
  - [ ] Optional elevated repair of the Visual Studio Build Tools registration so `vswhere`/`rustc` find the tools without `vcvars64.bat` (`docs/architecture.md` §12)
  - [ ] User decision on ADR-0012 amendment A (private working set metric and proposed targets)
- **Acceptance criteria:** A fresh clone builds, lints and tests from documented commands; CI is green; the skeleton runs on the reference laptop; baseline measurements are recorded; the gate decision is recorded and approved by the user; no feature code exists.
- **Testing requirements:** Measurement runs are repeatable and recorded verbatim (including failures); lint and tests pass; installer artifact installs and uninstalls cleanly on the dev machine.

## Phase 3 — MVP: the working product (started 2026-11-08 on the owner's explicit instruction)

- **Status:** in-progress. The owner merged the former Phase 3 (core), Phase 4 (café) and parts of Phase 5 into one execution on 2026-11-08 and accepted ADR-0012 amendment A. Phase 2 tasks 2.7–2.10 (tooling, security baseline, CI, doc refresh) were not run separately; the parts the product needs (CSP/capabilities, lint/test commands) are done here and ticked below.
- **Objective:** end-to-end workflow: describe task → ChatGPT drafts a Claude prompt (streamed) → user edits/approves → Claude Code executes with real events and permission prompts → result accepted or changes requested; café reacts to real state; history persists in SQLite.
- **Tasks (tick only when verified):**
  - [x] A. Accept ADR-0012 amendment A (private working set, 120/140 MB); record ADR-0007/8/9 as accepted-for-experimental-implementation
  - [x] B. Café redesign (verified 2026-11-08): original pixel art generated in code (`src/cafe/`), 288x176 logical canvas scaled nearest-neighbour; Reasoner and Executor sprites with idle/thinking/writing/present/typing/reading/attention/celebrate/error poses, walking between spots, speech bubbles, quest ticket states. Scene state comes only from `src/domain/scene.ts` (unit-tested projection of real task status, stream, permission and current tool). Screenshots viewed in the running app
  - [x] C1. SQLite persistence, migrations, corrupt-file recovery, interrupted-run reconciliation (verified: 3 unit tests; tasks, statuses and activity restored after real app restarts)
  - [ ] C2. ChatGPT Reasoner: implemented (PKCE, loopback callback, state/nonce checks, Credential Manager, refresh, model discovery, streamed Responses, error taxonomy). Verified: unit tests (ID-token checks, redaction, query parsing); sign-in start shows the waiting state and the authorize link; a wrong-state callback is rejected and shown. **NOT verified: completing a real sign-in, token refresh, model list and a streamed prompt. They need the owner to approve consent in their browser. Left unticked.**
  - [x] C3. Claude Executor (verified against the real claude.exe 2.1.319 on a disposable folder): detection, signature and auth status; stream-json run; MCP approver round trip (allow and deny); read/edit/write/Bash events in the activity feed; deny is not a failure; cancel interrupts gracefully and the process tree is cleaned (Job Object, taskkill fallback); no leftover processes
  - [ ] D. Orchestration workflow + UI: implemented and exercised from an approved prompt through result, accept and history with the real Claude CLI. The front half (describe, ChatGPT streams the prompt, edit) is implemented but unexercised for the reason in C2. Left unticked until a real ChatGPT run happens
  - [x] E. (partial, verified) disposable-project runs (allow, deny, cancel), process cleanup, performance re-measured (`docs/measurements/phase3/`), NSIS installer 2.57 MiB installs, launches and uninstalls cleanly. Not done: 8 h soak, ChatGPT end-to-end
  - [x] Removed the Phase 2 `bench_*` fixtures; the verification seed is the opt-in `dev-seed` cargo feature (not in the installer)
- **Acceptance criteria:** the 16-step workflow in the owner's Phase 3 brief works with the real providers (ChatGPT subject to account eligibility), no orphan processes, no secrets in logs or Git, records survive restart, installer installs/launches/uninstalls.
- **External blockers (unchanged, see release blockers):** OpenAI Go eligibility unconfirmed; OpenAI DevKit/terms review; Anthropic third-party subscription-use policy. The app is a local, user-controlled integration and must not be distributed or marketed as approved.

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
- 2026-11-08 — Phase 2 tasks 2.0–2.6 completed and verified; measurement gate assessed (`docs/architecture.md` §13) and left for the user's review. Tasks 2.7–2.10 untouched. ADR-0012 amendment A drafted as `proposed`. Carried-forward items added to Phase 2. No tasks removed.
- 2026-11-08 — Owner started Phase 3 (full product). ADR-0012 amendment A accepted. ADR-0007/8/9 accepted for experimental implementation (not for distribution). Phase 3 section rewritten to the owner's A–E milestones; old Phase 3 task list superseded (its intent is covered). Kenney assets could not be fetched (site blocks scripted download; I did not bypass it): café art is original and generated in code.
- 2026-11-08 — Phase 3 executed on the owner's instruction: backend (SQLite, ChatGPT, Claude), generated pixel café, workflow UI, CSP, installer. ChatGPT end-to-end and 8 h soak not verified. Tasks 2.7 (lint/format tooling) and 2.9 (CI) still not done; 2.8 partly (CSP and minimal capabilities done; single-instance not done).
- 2026-11-08 — Added: Claude model selector (default Sonnet), project-aware ChatGPT prompting with local sanitized context, café welcome dialogue. See `docs/architecture.md` §16.
- 2026-11-08 — Sprint 2: execution terminal-state fix (result-driven lifecycle), compact speech bubbles, Guild Chat with Claude read-only research and ChatGPT handoff, per-quest Auto Pilot. 'Allow edits' no longer delegates to Claude acceptEdits (it silently allowed rm/mv). See `docs/architecture.md` §17.
- 2026-11-08 — Sprint 3: repository workspaces and identity, chat history, autonomous ChatGPT-Claude research, quest history, per-repository trust and permissions, launched-services lifecycle, Claude in Chrome integration, header cleanup, Library bookshelf. See `docs/architecture.md` §18.
