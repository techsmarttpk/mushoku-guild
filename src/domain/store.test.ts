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

test("run_finished is the single terminal event: it ends the running state, hides cancel and is idempotent", () => {
  let s = ev(selected(), { type: "task_status", taskId: 1, status: "running" });
  s = ev(s, { type: "run_started", taskId: 1, executionId: 7, autopilot: true });
  assert.equal(s.autopilot, true);
  s = ev(s, { type: "run_permission", taskId: 1, requestId: "p", toolName: "Bash", summary: "ls", input: "{}", reason: null });
  const fin: AppEvent = { type: "run_finished", taskId: 1, executionId: 7, status: "completed", result: "done", note: null, exitCode: 0 };
  s = ev(s, fin);
  assert.deepEqual([s.detail?.task.status, s.tasks[0]?.status, s.permissions.length, s.autopilot, s.currentTool], ["completed", "completed", 0, false, null]);
  assert.equal(ev(s, fin).detail?.task.status, "completed");
});

test("failed and cancelled outcomes are never shown as completed, even for a task that is not open", () => {
  const failed = ev(selected(), { type: "run_finished", taskId: 1, executionId: 1, status: "failed", result: null, note: "boom", exitCode: 1 });
  assert.equal(failed.detail?.task.status, "failed");
  assert.equal(ev(selected(), { type: "run_finished", taskId: 1, executionId: 1, status: "cancelled", result: null, note: null, exitCode: 1 }).detail?.task.status, "cancelled");
  assert.equal(ev(selected(), { type: "run_finished", taskId: 1, executionId: 1, status: "weird", result: null, note: null, exitCode: null }).detail?.task.status, "failed");
  const other = reduce({ ...initialState, tasks: [task], selectedTaskId: 99 }, { type: "event", event: { type: "run_finished", taskId: 1, executionId: 1, status: "completed", result: null, note: null, exitCode: 0 } });
  assert.equal(other.tasks[0]?.status, "completed");
});

test("reopening a running quest restores its Auto Pilot mode from the stored execution", () => {
  const running: TaskDetail = { task: { ...task, status: "running" }, drafts: [], events: [], executions: [{ id: 1, taskId: 1, policy: "ask_each", status: "running", startedAt: 0, endedAt: null, resultText: null, numTurns: null, denialCount: 0, note: null, exitCode: null, permissionMode: "autopilot" }] };
  assert.equal(reduce(initialState, { type: "select_task", detail: running }).autopilot, true);
  assert.equal(reduce(initialState, { type: "select_task", detail: { ...running, task: { ...task, status: "completed" } } }).autopilot, false);
});

test("chat: messages persist in order, deltas stream into one reply and a stale generation is ignored", () => {
  const conv = { id: 5, projectId: 1, title: "t", updatedAt: 0 };
  const user = { id: 1, conversationId: 5, role: "user" as const, body: "hi", createdAt: 0 };
  let s = reduce(initialState, { type: "chat_opened", conversation: conv, messages: [], research: { status: "none", researchedAt: null, files: [], report: "", note: null } });
  s = reduce(s, { type: "chat_sending", message: user, generation: 3 });
  s = ev(s, { type: "chat_delta", conversationId: 5, generation: 3, text: "Hel" });
  s = ev(s, { type: "chat_delta", conversationId: 5, generation: 3, text: "lo" });
  s = ev(s, { type: "chat_delta", conversationId: 5, generation: 2, text: "STALE" });
  s = ev(s, { type: "chat_delta", conversationId: 6, generation: 3, text: "OTHER" });
  assert.equal(s.chatStream, "Hello");
  const reply = { id: 2, conversationId: 5, role: "assistant" as const, body: "Hello", createdAt: 1 };
  s = ev(s, { type: "chat_done", conversationId: 5, generation: 3, message: reply });
  s = ev(s, { type: "chat_done", conversationId: 5, generation: 3, message: reply });
  assert.deepEqual(s.chatMessages.map((m) => m.body), ["hi", "Hello"]);
  assert.deepEqual([s.chatStreaming, s.chatStream], [false, ""]);
});

test("research events update the context status and keep the previous report on failure", () => {
  const conv = { id: 5, projectId: 1, title: "t", updatedAt: 0 };
  let s = reduce(initialState, { type: "chat_opened", conversation: conv, messages: [], research: { status: "ready", researchedAt: 100, files: ["a.ts"], report: "# R", note: null } });
  s = ev(s, { type: "research_finished", projectId: 1, research: { projectId: 1, status: "failed", report: "", files: [], researchedAt: 200, note: "boom" } });
  assert.deepEqual([s.research?.status, s.research?.report, s.research?.researchedAt, s.research?.note], ["failed", "# R", 100, "boom"]);
  s = ev(s, { type: "research_finished", projectId: 1, research: { projectId: 1, status: "ready", report: "# New", files: ["b.ts"], researchedAt: 300, note: null } });
  assert.deepEqual([s.research?.status, s.research?.report, s.research?.researchedAt], ["ready", "# New", 300]);
});
