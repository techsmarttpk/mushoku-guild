import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, reduce, type UiState } from "./store.ts";
import type { AppEvent, Task, TaskDetail } from "./types.ts";

const task: Task = { id: 1, projectId: 1, title: "t", description: "d", status: "draft", createdAt: 0, updatedAt: 0 };
const detail: TaskDetail = { task, drafts: [], executions: [], events: [] };
const selected = (): UiState => reduce({ ...initialState, tasks: [task] }, { type: "select_task", detail });
const ev = (s: UiState, event: AppEvent) => reduce(s, { type: "event", event });

test("streamed deltas accumulate and are ignored for other tasks or stale generations", () => {
  let s = reduce(selected(), { type: "generation_started", generation: 2 });
  s = ev(s, { type: "reasoner_delta", taskId: 1, generation: 2, text: "Hel" });
  s = ev(s, { type: "reasoner_delta", taskId: 1, generation: 2, text: "lo" });
  s = ev(s, { type: "reasoner_delta", taskId: 9, generation: 2, text: "X" });
  s = ev(s, { type: "reasoner_delta", taskId: 1, generation: 1, text: "stale" });
  assert.equal(s.streamText, "Hello");
  assert.equal(s.streaming, true);
});

test("tool_use sets the current tool and its result clears it", () => {
  let s = selected();
  s = ev(s, { type: "run_activity", taskId: 1, activity: { seq: 1, ts: 0, kind: "tool_use", title: "Bash", detail: "ls" } });
  assert.equal(s.currentTool, "Bash");
  s = ev(s, { type: "run_activity", taskId: 1, activity: { seq: 2, ts: 0, kind: "tool_result", title: "Bash finished", detail: "" } });
  assert.equal(s.currentTool, null);
  assert.equal(s.activity.length, 2);
});

test("permission requests queue until resolved", () => {
  let s = selected();
  s = ev(s, { type: "run_permission", taskId: 1, requestId: "a", toolName: "Bash", summary: "ls", input: "{}" });
  assert.equal(s.permissions.length, 1);
  s = ev(s, { type: "run_permission_resolved", requestId: "a", decision: "deny" });
  assert.equal(s.permissions.length, 0);
});

test("status events update both the list and the open task", () => {
  const s = ev(selected(), { type: "task_status", taskId: 1, status: "running" });
  assert.equal(s.tasks[0]?.status, "running");
  assert.equal(s.detail?.task.status, "running");
});

test("a cancelled reasoner is not shown as an error", () => {
  const s = ev(selected(), { type: "reasoner_failed", taskId: 1, generation: 1, kind: "cancelled", message: "Cancelled." });
  assert.equal(s.error, null);
});
