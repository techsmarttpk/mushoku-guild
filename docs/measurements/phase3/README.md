# Phase 3 measurements (real product, release build)

Measured 2026-11-08 on the Phase 2 machine (i5-10300H, 15.8 GB, hybrid GPU, AC power, WebView2 157, other apps running). Build: release with the `dev-seed` cargo feature (verification only, never shipped) so a real Claude Code run could start without the ChatGPT sign-in. Tool: `tools/measure/phase3.mjs` + `sampler.ps1`. ADR-0012 amendment A applies: **private working set** is the budget metric; summed working set is in the JSON files.

**`claude.exe` and its children (including the MCP approver) are excluded** from the app tree (ADR-0012 qualification 4); the sampler removes that subtree.

| Metric (run1, run2) | Result | Budget (ADR-0012 + amendment A) |
|---|---|---|
| Startup to canvas present | 1.02 s, 1.03 s | <= 2.5 s |
| Idle CPU (café open, 45 s) | 0.17 %, 0.19 % mean; max 0.78 %, 1.00 % | <= 2 % |
| Idle private working set | 98.1, 99.9 MB (summed WS about 385 MB, not a budget metric) | <= 120 MB |
| Active CPU (real Claude run, 14 s and 10 s) | 1.16 %, 0.94 % mean; max 2.8 %, 2.3 % | <= 8 % |
| Active private working set | 102.6, 106.8 MB mean (max 108 MB) | <= 140 MB |
| Process count (app + WebView2) | 7 | <= 8 |
| Installer | 2.57 MiB; installed 6.1 MB | <= 15 MB / <= 60 MB |

Limits: short active runs (10-14 s, 4-6 turns); no multi-hour soak; minimised and unfocused states were not re-measured in Phase 3 (the Phase 2 mechanism is unchanged: no rAF loop, scene stops on minimise); first-ever-launch start-up not measured. A first measurement (not kept) wrongly counted `claude.exe` (228 MB private, 10 processes); the sampler now excludes it.
