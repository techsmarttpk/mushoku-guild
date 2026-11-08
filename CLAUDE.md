# CLAUDE.md — Mushoku Guild Engineering Constitution

This file is the persistent instruction set for Claude Code in this repository. Follow it in every session. If it conflicts with a casual request, say so and ask; if the user explicitly overrides it, follow the user and record the change in `docs/DECISIONS.md`.

## 1. Project identity and vision

**Mushoku Guild** is a lightweight, game-inspired desktop application for orchestrating AI-assisted software development workflows. AI agents appear as characters in a cozy café / guild environment; development tasks appear as quests or orders.

It exists to remove manual copy-paste between a prompt-engineering assistant (e.g. ChatGPT) and an executing coding agent (e.g. Claude Code), while keeping the user in control. See `docs/context.md` for the full background, and for which parts are confirmed versus assumed.

## 2. Core objectives

1. Automate the "describe task → engineer prompt → hand off → execute → review" workflow.
2. Real, functional agent integrations — never simulated activity presented as real.
3. Clear visibility into what each agent is doing.
4. The user approves and controls task execution.
5. Lightweight: minimal CPU and RAM.
6. Modular, so additional agents can be added later.
7. Game-like presentation that never sacrifices usability.

## 3. Required reading before substantial changes

All project documentation lives in `docs/`; only this file stays in the repository root so Claude Code discovers it automatically.

Before any non-trivial change, read, in this order:

1. `docs/context.md` — purpose, confirmed requirements, open questions
2. `docs/DECISIONS.md` — what has been decided (and what has not)
3. `docs/ARCHITECTURE.md` — components and stack
4. `docs/system-design.md` — HLD and LLD
5. `docs/plan.md` — current phase, status, next tasks

"Substantial" means: new modules, new dependencies, interface or data-model changes, anything crossing component boundaries, or anything that affects a decision. Typo fixes and local bug fixes do not require a full re-read.

## 4. Engineering principles

- **Inspect before modifying.** Read the code and the docs; don't assume.
- **Simplicity over abstraction.** Build the simplest thing that meets the current phase's acceptance criteria.
- **No overengineering.** No plugin frameworks, generic layers, config systems, or abstractions for hypothetical needs. Introduce an abstraction only when a second concrete use exists or a documented requirement demands it (modularity for future agents is a confirmed requirement; satisfy it with the smallest adapter boundary that works).
- **Minimal dependencies.** Every dependency needs a stated reason and a note in `docs/DECISIONS.md` if it is significant (runtime, UI toolkit, storage, etc.). Prefer the standard library and platform facilities.
- **No premature optimisation**, but **stay resource-conscious** (see §9).
- **Incremental, verifiable changes.** Small steps, each checked.
- **Preserve user work.** Never discard uncommitted changes, overwrite files without reading them, or rewrite remote history.
- **User stays in control.** Agent actions that modify code, run commands, or spend resources require explicit user approval unless the user has configured otherwise.

## 5. Coding standards

Stack (ADR-0010, accepted 2026-11-08): **Rust** (Tauri 2 core), **TypeScript + React** (UI), **PixiJS** (café scene), **SQLite** via rusqlite. Stack-specific tooling (rustfmt, clippy, ESLint/Prettier, TypeScript strict, test runners) is selected in Phase 2 task 2.7 and then enforced; until then these language-neutral rules apply.

- Readable over clever. Small functions, clear names, one responsibility per module.
- Comments explain *why*, not *what*.
- Handle errors explicitly; never swallow them silently. Surface failures to the user in a clear form.
- No secrets in the repo. API keys and tokens come from environment or OS credential storage.
- Treat all agent output and external input as untrusted data.
- No dead code, no commented-out code, no unused dependencies.
- Every module with logic gets tests proportionate to its risk. Integration code is tested against the real agent where feasible (see §8).
- Formatting and lint must pass before commit once tooling exists.

## 6. Documentation requirements

- Documentation is part of the work, not an afterthought.
- Update docs **in the same change** whenever any of these change:
  - architecture or components → `docs/ARCHITECTURE.md` (and `docs/system-design.md` if interfaces/models change)
  - a decision is made, changed or reversed → `docs/DECISIONS.md` (append; supersede, don't erase)
  - requirements, status, or learned facts → `docs/context.md`
  - task progress → `docs/plan.md` (immediately after meaningful work)
- Mark status honestly: **proposed**, **accepted**, **implemented**, **verified**. Never describe a proposed design as implemented.
- Do not turn assumptions into decisions silently. An assumption becomes a decision only through an entry in `docs/DECISIONS.md` with status `accepted` and the user's agreement.
- Keep docs consistent with each other. After editing one, check the others for contradictions.

## 7. Git workflow and commit conventions

- Default branch: `main`. For non-trivial work use short-lived branches: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
- Commit messages follow Conventional Commits: `type(scope): summary` — types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`. Imperative mood, summary ≤ 72 chars, body explains why when non-obvious.
- One logical change per commit. Don't mix docs-only and code changes unless they belong together.
- Never force-push. Never rewrite published history. Never skip hooks.
- Check `git status` before committing; stage specific files, not blindly everything.
- Commit and push only when asked, or when the user has explicitly authorised it for the current task.
- Remote: `https://github.com/techsmarttpk/mushoku-guild.git`.

## 8. Verification before completion

A task is **not complete** until verified. Verification means evidence, not belief:

- Code: it builds, lint passes, relevant tests pass, and the behaviour was actually exercised.
- Integrations: tested against the real agent/tool at least once. If it could not be tested (missing credentials, offline), say so and leave the task unchecked.
- Docs: re-read for accuracy and consistency.
- Only then tick the checkbox in `docs/plan.md`.

**No hallucinated functionality.** Never claim something works, exists, or passes without having run it. Never fabricate test output, benchmarks, or integration results. Report failures and skipped steps plainly, with the actual output. If you are unsure, say "unverified".

## 9. Resource-conscious development

Lightweight is a core requirement, not a nice-to-have.

- No heavy game engine without a documented trade-off evaluation and an accepted decision.
- Idle state should use near-zero CPU: no busy loops, event-driven updates, throttled rendering when the window is hidden or unfocused.
- Be deliberate with memory: bounded logs/history, lazy-loaded assets, compressed sprites.
- Keep installer size and dependency tree small.
- Resource budgets are **provisional engineering targets** (ADR-0012; `docs/ARCHITECTURE.md` §9). Measure, do not assume: record method, environment and numbers in `docs/plan.md` / `docs/ARCHITECTURE.md`, and never quote an unmeasured figure as a result. Stability and security take priority over any performance number. If a target is unrealistic, document the evidence and propose a revised target for the user's approval. Measure `claude.exe` consumption separately from Mushoku Guild's own.

## 10. Scope discipline

- Do only what the current phase and the user's request ask for.
- Do not jump to a later phase while mandatory dependencies in the current one are incomplete.
- Do not refactor unrelated code opportunistically.
- When requirements are unclear, ask or record an open question in `docs/context.md`; don't guess.

## 11. Session checklist

1. Read the required docs (§3).
2. Check `git status`; don't clobber existing work.
3. Make the change in small steps.
4. Verify (§8).
5. Update docs and `docs/plan.md` (§6).
6. Commit per §7.
7. Report honestly: what was done, what was verified, what wasn't.
