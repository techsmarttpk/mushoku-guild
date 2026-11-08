# context.md — Mushoku Guild Long-Term Context

Working memory for the project. Future sessions must read this first. Every item is labelled **[Confirmed]**, **[Assumption]** or **[Open]**. Do not promote assumptions to requirements without the user's agreement (record in `DECISIONS.md`).

_Last updated: 2026-11-08 (repository initialisation)._

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

1. **ChatGPT integration route:** is it the OpenAI API, or the ChatGPT product (no public API for the consumer app)? What does the user have access to / want to pay for?
2. **Claude Code integration route:** spawn the CLI as a subprocess, use the Agent SDK, or other? Needs a spike.
3. **Which platforms** must be supported at MVP?
4. **MVP scope of the café:** static scene with status, or animated characters? How much "game" at first?
5. **Approval model:** what exactly needs approval (prompt handoff, each tool call, each task)?
6. **Review step:** should the app help automate review (e.g., a reviewer agent), or only present results for human review?
7. **Persistence:** are task history and prompts stored? For how long?
8. **Resource budgets:** concrete CPU/RAM targets (currently TBD; to be set from measured baselines).
9. **Name/IP:** art and character assets — who produces them, licensing?
10. **Distribution:** installer, auto-update, open source or private?

## 9. Current project status

- **Phase:** 0 — Repository initialisation (see `plan.md`).
- Repository created at `https://github.com/techsmarttpk/mushoku-guild`, branch `main`.
- Governance and design documents established.
- **No application code exists. No technology has been chosen. No integration has been tested.**

## 10. Things future sessions must retain

- Documentation-first: no implementation until the user asks and the discovery phase's exit criteria in `plan.md` are met.
- Do not claim integrations work until tested against the real agent.
- Tech stack selection requires a written trade-off evaluation and a `DECISIONS.md` entry.
- Lightweight is a hard constraint; don't add a heavy engine or framework casually.
- The user's environment: Windows 11, Git Bash/PowerShell, working directory `D:\Projects\mushoku-guild`.
