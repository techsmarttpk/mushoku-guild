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

## Proposed (not decided)

None are recorded here yet. Candidate decisions to be raised during Discovery, each of which needs user agreement before becoming `accepted`:

- UI/runtime technology and rendering approach (lightweight 2D vs. alternatives).
- Agent integration mechanism for Claude Code and for the prompt-engineering agent.
- Agent adapter interface shape.
- Local persistence approach.
- Approval model for agent actions.
