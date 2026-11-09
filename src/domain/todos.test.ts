import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_VIEW, applyView, dueLabel, isOverdue, progress, todayLocal, type Todo } from "./todos.ts";

let seq = 0;
const todo = (over: Partial<Todo>): Todo => ({ id: ++seq, title: "t", description: "", priority: "medium", due: null, done: false, doneAt: null, projectId: null, createdAt: seq, updatedAt: seq, ...over });
const TODAY = "2026-11-09";
const names: Record<number, string> = { 1: "mushoku-guild", 2: "other-repo" };
const name = (id: number): string => names[id] ?? "";
const view = (over = {}) => ({ ...DEFAULT_VIEW, filter: "all" as const, ...over });

const SET = [
  todo({ title: "Fix authentication UI", priority: "high", due: "2026-11-08", projectId: 1 }),
  todo({ title: "Read the new research paper", priority: "low", due: "2026-11-20" }),
  todo({ title: "Update project README", priority: "medium", due: TODAY, projectId: 1 }),
  todo({ title: "Check GitHub issues", priority: "medium", projectId: 2 }),
  todo({ title: "Explore a SaaS idea", priority: "high", done: true, doneAt: 5 }),
];

test("local date is the computer's calendar date", () => {
  assert.equal(todayLocal(new Date(2026, 10, 9, 23, 59)), "2026-11-09");
  assert.equal(todayLocal(new Date(2026, 0, 5, 0, 0)), "2026-01-05");
});

test("overdue means unfinished and due before today", () => {
  assert.ok(isOverdue(SET[0]!, TODAY));
  assert.ok(!isOverdue(SET[2]!, TODAY), "due today is not overdue");
  assert.ok(!isOverdue({ ...SET[0]!, done: true }, TODAY), "finished items are never overdue");
  assert.ok(!isOverdue(SET[3]!, TODAY), "no due date");
  assert.equal(dueLabel(SET[2]!, TODAY), "due today");
  assert.match(dueLabel(SET[0]!, TODAY), /overdue/);
});

test("filters: all, active, completed, overdue", () => {
  const titles = (f: "all" | "active" | "completed" | "overdue") => applyView(SET, view({ filter: f }), TODAY, null, name).map((t) => t.title);
  assert.equal(titles("all").length, 5);
  assert.equal(titles("active").length, 4);
  assert.deepEqual(titles("completed"), ["Explore a SaaS idea"]);
  assert.deepEqual(titles("overdue"), ["Fix authentication UI"]);
});

test("search matches title, description and repository name", () => {
  const found = (q: string) => applyView(SET, view({ query: q }), TODAY, null, name).map((t) => t.title);
  assert.deepEqual(found("README"), ["Update project README"]);
  assert.deepEqual(found("RESEARCH paper"), ["Read the new research paper"]);
  assert.equal(found("other-repo").length, 1);
  assert.equal(found("zzz").length, 0);
});

test("sorting by due date, priority and creation date keeps completed items last", () => {
  const order = (s: "due" | "priority" | "created") => applyView(SET, view({ sort: s }), TODAY, null, name).map((t) => t.title);
  assert.deepEqual(order("due"), ["Fix authentication UI", "Update project README", "Read the new research paper", "Check GitHub issues", "Explore a SaaS idea"]);
  assert.deepEqual(order("priority"), ["Fix authentication UI", "Update project README", "Check GitHub issues", "Read the new research paper", "Explore a SaaS idea"]);
  assert.deepEqual(order("created"), ["Check GitHub issues", "Update project README", "Read the new research paper", "Fix authentication UI", "Explore a SaaS idea"]);
});

test("global to-dos stay visible in every repository; the repository filter is explicit", () => {
  const visible = (active: number | null, repoOnly: boolean) => applyView(SET, view({ repoOnly }), TODAY, active, name).map((t) => t.title);
  // switching repositories never hides global tasks while the repository filter is off
  assert.equal(visible(1, false).length, 5);
  assert.equal(visible(2, false).length, 5);
  assert.equal(visible(null, false).length, 5);
  // with the filter on, only the active repository's own tasks remain
  assert.deepEqual(visible(1, true).sort(), ["Fix authentication UI", "Update project README"]);
  assert.deepEqual(visible(2, true), ["Check GitHub issues"]);
  assert.deepEqual(visible(null, true), []);
});

test("progress summary counts completed and overdue", () => {
  assert.deepEqual(progress(SET, TODAY), { done: 1, total: 5, percent: 20, overdue: 1 });
  assert.deepEqual(progress([], TODAY), { done: 0, total: 0, percent: 0, overdue: 0 });
});
