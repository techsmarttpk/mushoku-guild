# Phase 2 measurements (tasks 2.3–2.6)

Raw data and method for the Phase 2 measurement gate. Everything here is **measured on one machine**; conclusions and the gate verdict are in `docs/ARCHITECTURE.md` §13 and `docs/plan.md`.

## Environment (all runs)
Windows 11 Home 10.0.26200; Intel Core i5-10300H (4 cores / 8 logical); 15.8 GB RAM; Intel UHD Graphics + NVIDIA GeForce GTX 1650 (hybrid); WebView2 runtime 157.0.4341.42; **on AC power**; Windows power scheme "Gaming"; other applications and a Claude Code session were running, so absolute CPU numbers include ordinary desktop background noise. One user, one machine, release build of the app (`src-tauri/target/release/mushoku-guild.exe`).

## Method
- `tools/measure/measure.mjs` launches the release exe, waits for the app's own ready marker (**startup time = process spawn to the app reporting its first rendered frame**, so it includes process creation, WebView2 start-up and first render; WebView2 user data was warm, a first-ever launch was not separately measured), puts the window in the scenario state (`tools/measure/window.ps1`), waits a settle period, then samples the **app process tree** once per second with `tools/measure/sampler.ps1`, then kills the tree.
- The tree is the app process plus every `msedgewebview2.exe` it owns (7 processes: app, WebView2 browser, GPU, renderer, 2 utility, crashpad handler). **`claude.exe` is not part of any of these measurements** (ADR-0012 qualification 4); Claude CLI consumption was measured separately in `docs/context.md` §13.8.
- **RAM:** `wsMB` = sum of working sets of the tree (this is the metric ADR-0012 literally names; it **double-counts pages shared between the WebView2 processes**); `privMB` = sum of private working sets (not shared). Both are reported.
- **CPU:** percentage of *total* machine CPU (all 8 logical processors) from kernel+user time deltas of the tree's processes, per 1 s sample. "mean" is the mean of the per-sample values for the run; the summary tables give the mean of the run means and the worst single-second sample. Single-second samples are noisy (spikes up to several %).
- **Frame rate:** the app records its own scene step and draw counters at two one-shot marks inside the sampling window; the harness divides by the elapsed time (`ticks/s`, `renders/s`). This verifies what the scene really did, not what it was configured to do.
- **Event latency:** the Rust core stamps each tick with Unix time; the frontend subtracts it from `performance.timeOrigin + performance.now()` on arrival. Same machine, same clock source, so about 1 ms of clock uncertainty remains.
- Runs per scenario: 3 (final data). Sampling windows: 60 s (focused idle), 45 s (other idle states), 35 s (active, inside a 45 s stream at 60 events/s).

## Scenarios
| Scenario | State |
|----------|-------|
| `idle-blank` | Tauri window + React shell only; Pixi/WebGL never created. The platform floor. |
| `idle-static` | Scene created, drawn once, nothing scheduled. |
| `idle-focused` | Ambient idle animation (the normal "café open, nothing happening" state), window focused. |
| `idle-minimized` | Same, window minimised by the harness. |
| `idle-hidden` | Same, window hidden with `ShowWindow(SW_HIDE)` from outside the app. The app cannot detect this, so it keeps animating; reported to document that limit. A window hidden by the app itself is a different case (the app knows). |
| `active-focused` | 30 fps scene + 60 events/s over the Tauri Channel. A rendering/IPC load fixture, **not** agent activity. |

## Files
- `raw/<tag>-<scenario>-run<N>.json` — one record per run (config, startup, window states, every 1 s sample, app-reported marks).
- `<tag>-summary.json` — environment and per-scenario aggregates for a suite.
- Tags: `main` (first suite, early scene: re-render every tick, Pixi system ticker running), `floor` (blank vs static vs ambient on the same binary), `gpu` and `gpupref-igpu` (GPU engine counters; the second with the Windows graphics preference for the WebView2 runtime temporarily set to power saving and then removed), `var-*`/`var2-*` (diagnostic variants used to find the static-scene CPU floor: hide canvas, detach canvas, lose WebGL context, destroy the Pixi app, stop Pixi's system ticker), `final` (render-every-tick scene with both tickers driven), `final2` (the shipped scene design: timer-driven ambient mode), `gpu2` (GPU engine counters on the final design). **Only `final2` describes the current code**; the earlier tags are kept as evidence for the findings they support. Their binaries no longer exist.
- `raw/invalid/` — blur scenarios from `main` and `final`. **Invalid:** the harness could not take OS focus away from the app in those runs (`blur` reported the app still foreground), so they measured a focused window. They are kept only to show the problem and must not be quoted.

## Known limits of these measurements
- One machine, one build, one boot, one WebView2 version; three runs per scenario.
- Windows focus is not reliably controllable from the harness in this environment, so the "visible but unfocused" state is **not measured** (a manual check showed that an unfocused window still renders and that blur is delivered to the page).
- Memory growth over hours (soak test) and idle disk writes were **not measured**.
- GPU engine utilisation reads 0% (integer counter granularity) in every state, which only shows the GPU load is small.
- The harness's own sampling (PowerShell/WMI) is outside the measured process tree, but it does add load to the machine.
