import assert from "node:assert/strict";
import { test } from "node:test";
import { HEALTHY, MAX_AUTO_REBUILDS, MAX_DRAW_FAILURES, nextHealth, rebuildDelay, shouldAutoRebuild, type RenderHealth } from "./renderHealth.ts";

test("a restored context returns to healthy without a rebuild", () => {
  let h: RenderHealth = nextHealth(HEALTHY, { type: "context_lost" });
  assert.equal(h.state, "lost");
  h = nextHealth(h, { type: "context_restored" });
  assert.deepEqual(h, HEALTHY);
});

test("a context that never returns becomes a failure the UI can show and retry", () => {
  let h = nextHealth(HEALTHY, { type: "context_lost" });
  h = nextHealth(h, { type: "restore_timeout" });
  assert.equal(h.state, "failed");
  assert.match(h.reason ?? "", /did not come back/);
  // a late restore event cannot silently revive a failed scene: only an explicit rebuild does
  assert.equal(nextHealth(h, { type: "context_restored" }).state, "failed");
  assert.deepEqual(nextHealth(h, { type: "rebuilt" }), HEALTHY);
});

test("a restore timeout after the context already came back is ignored", () => {
  const h = nextHealth(nextHealth(HEALTHY, { type: "context_lost" }), { type: "context_restored" });
  assert.equal(nextHealth(h, { type: "restore_timeout" }).state, "ok");
});

test("one draw error is tolerated; repeated ones fail the scene; a good draw resets the count", () => {
  let h = HEALTHY;
  h = nextHealth(h, { type: "draw_error", message: "boom" });
  h = nextHealth(h, { type: "draw_error", message: "boom" });
  assert.equal(h.state, "ok");
  h = nextHealth(h, { type: "draw_ok" });
  assert.equal(h.drawFailures, 0);
  for (let i = 0; i < MAX_DRAW_FAILURES; i++) h = nextHealth(h, { type: "draw_error", message: "boom" });
  assert.equal(h.state, "failed");
  assert.match(h.reason ?? "", /boom/);
});

test("start-up failure is reported instead of leaving a blank canvas", () => {
  const h = nextHealth(HEALTHY, { type: "init_error", message: "WebGL unavailable" });
  assert.equal(h.state, "failed");
  assert.match(h.reason ?? "", /WebGL unavailable/);
});

test("automatic rebuilds are bounded, then the user must press Retry", () => {
  const now = 1_000_000;
  assert.ok(shouldAutoRebuild([], now));
  const hist: number[] = [];
  for (let i = 0; i < MAX_AUTO_REBUILDS; i++) {
    assert.ok(shouldAutoRebuild(hist, now + i));
    hist.push(now + i);
  }
  assert.ok(!shouldAutoRebuild(hist, now + 10));
  assert.ok(shouldAutoRebuild(hist, now + 120_000), "old attempts expire");
  assert.ok(rebuildDelay(hist, now + 10) > rebuildDelay([], now + 10), "back off");
});
