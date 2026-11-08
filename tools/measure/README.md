# Phase 2 measurement harness (historical)

`measure.mjs`, `sampler.ps1` and `window.ps1` were written for the Phase 2 gate (`docs/measurements/phase2/`). They relied on
the Phase 2 `bench_*` fixtures, which were removed from the product in Phase 3 (commit following 60cf53f). They still work
against a build of commit `dcf2378` or earlier. `sampler.ps1` alone (process-tree CPU, working set and private working set)
is reused for Phase 3 measurements; see `docs/measurements/phase3/`.
