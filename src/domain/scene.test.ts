import assert from "node:assert/strict";
import { test } from "node:test";
import { executorPoseForTool, projectScene, type SceneInput } from "./scene.ts";

const base: SceneInput = { status: null, streaming: false, permissionPending: false, currentTool: null };

test("idle when nothing is happening", () => {
  const s = projectScene(base);
  assert.equal(s.reasoner.pose, "idle");
  assert.equal(s.executor.pose, "idle");
  assert.equal(s.board, "empty");
});

test("reasoner thinks, then writes once text really streams", () => {
  assert.equal(projectScene({ ...base, status: "reasoning" }).reasoner.pose, "thinking");
  assert.equal(projectScene({ ...base, status: "reasoning", streaming: true }).reasoner.pose, "writing");
});

test("a finished prompt is presented on the board", () => {
  const s = projectScene({ ...base, status: "prompt_ready" });
  assert.deepEqual([s.reasoner.pose, s.reasoner.spot, s.board], ["present", "board", "pending"]);
});

test("executor pose follows the tool actually running", () => {
  assert.equal(executorPoseForTool("Bash"), "typing");
  assert.equal(executorPoseForTool("Edit"), "writing");
  assert.equal(executorPoseForTool("Grep"), "reading");
  assert.equal(executorPoseForTool(null), "thinking");
  assert.equal(projectScene({ ...base, status: "running", currentTool: "Write" }).executor.pose, "writing");
});

test("a pending permission request makes the executor stop and ask for attention", () => {
  const s = projectScene({ ...base, status: "running", currentTool: "Bash", permissionPending: true });
  assert.deepEqual([s.executor.pose, s.executor.bubble], ["attention", "alert"]);
});

test("end states: completed celebrates, failed shows an error, cancelled returns to idle", () => {
  assert.equal(projectScene({ ...base, status: "completed" }).executor.pose, "celebrate");
  const f = projectScene({ ...base, status: "failed" });
  assert.deepEqual([f.executor.pose, f.board], ["error", "failed"]);
  const c = projectScene({ ...base, status: "cancelled" });
  assert.deepEqual([c.executor.pose, c.executor.spot, c.board], ["idle", "lounge", "cancelled"]);
});
