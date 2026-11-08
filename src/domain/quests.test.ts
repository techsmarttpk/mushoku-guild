import assert from "node:assert/strict";
import { test } from "node:test";
import { BADGE_LABEL, filterQuests, modelName, questBadge, questStatusText, summaryOf } from "./quests.ts";
import type { QuestRow, TaskStatus } from "./types.ts";

const row = (o: Partial<QuestRow>): QuestRow => ({ id: 1, title: "t", status: "draft", createdAt: 0, updatedAt: 0, model: "sonnet", permissionMode: "ask", summary: "", ...o });

test("all nine stored statuses map onto the six history states", () => {
  const all: TaskStatus[] = ["draft", "reasoning", "prompt_ready", "approved", "running", "completed", "failed", "cancelled", "accepted"];
  const seen = new Set(all.map(questBadge));
  assert.deepEqual([...seen].sort(), ["awaiting", "cancelled", "completed", "draft", "failed", "running"]);
  assert.equal(BADGE_LABEL[questBadge("prompt_ready")], "Awaiting approval");
  assert.equal(questStatusText("accepted"), "Completed (accepted)");
});

test("a failed or cancelled quest is never labelled completed", () => {
  assert.equal(questBadge("failed"), "failed");
  assert.equal(questBadge("cancelled"), "cancelled");
});

test("history search covers title and summary; model names are readable", () => {
  const rows = [row({ id: 1, title: "Fix login", summary: "Patched the token check" }), row({ id: 2, title: "Add payments" })];
  assert.deepEqual(filterQuests(rows, "TOKEN").map((r) => r.id), [1]);
  assert.deepEqual(filterQuests(rows, "pay").map((r) => r.id), [2]);
  assert.equal(filterQuests(rows, "  ").length, 2);
  assert.equal(modelName("haiku"), "Haiku");
  assert.equal(modelName(""), "-");
  assert.equal(summaryOf(row({})), "No result yet");
});
