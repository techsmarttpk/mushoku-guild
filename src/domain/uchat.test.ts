import assert from "node:assert/strict";
import { test } from "node:test";
import { initialU, parseProvider, reduceU, type UState } from "./uchat.ts";
import { initialState, reduce } from "./store.ts";
import type { UConv, UMessage } from "./types.ts";

const conv = (id: number, provider: "chatgpt" | "claude"): UConv => ({ id, title: "New conversation", provider, model: "", createdAt: 0, updatedAt: 0 });
const msg = (id: number, conversationId: number, role: "user" | "assistant", body: string, status: UMessage["status"] = "complete"): UMessage => ({ id, conversationId, role, body, status, createdAt: id });

function send(s: UState, c: UConv, text: string, generation = 1): UState {
  return reduceU(s, { type: "sending", conversation: c, message: msg(100 + generation, c.id, "user", text), generation });
}

test("a ChatGPT conversation streams and completes", () => {
  const c = conv(1, "chatgpt");
  let s = send({ ...initialU }, c, "Brainstorm SaaS ideas");
  assert.ok(s.streaming && s.current?.provider === "chatgpt");
  s = reduceU(s, { type: "event", event: { type: "u_chat_delta", conversationId: 1, generation: 1, text: "Here " } });
  s = reduceU(s, { type: "event", event: { type: "u_chat_delta", conversationId: 1, generation: 1, text: "are ideas." } });
  assert.equal(s.stream, "Here are ideas.");
  s = reduceU(s, { type: "event", event: { type: "u_chat_done", conversationId: 1, generation: 1, message: msg(7, 1, "assistant", "Here are ideas.") } });
  assert.ok(!s.streaming && s.stream === "");
  assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant"]);
});

test("a Claude conversation behaves the same and keeps its own provider", () => {
  const c = conv(2, "claude");
  let s = send({ ...initialU, provider: "claude" }, c, "Explain lifetimes");
  s = reduceU(s, { type: "event", event: { type: "u_chat_done", conversationId: 2, generation: 1, message: msg(8, 2, "assistant", "Lifetimes…") } });
  assert.equal(s.current?.provider, "claude");
  assert.equal(s.messages.length, 2);
});

test("choosing the other provider never mixes histories: it starts a fresh draft", () => {
  const c = conv(1, "chatgpt");
  let s = reduceU({ ...initialU }, { type: "opened", conversation: c, messages: [msg(1, 1, "user", "hi"), msg(2, 1, "assistant", "hello")], hasMore: false });
  assert.equal(s.provider, "chatgpt");
  s = reduceU(s, { type: "provider", provider: "claude" });
  assert.equal(s.current, null);
  assert.equal(s.messages.length, 0);
  assert.equal(s.provider, "claude");
  // picking the same provider keeps the open conversation
  const kept = reduceU(reduceU({ ...initialU }, { type: "opened", conversation: c, messages: [msg(1, 1, "user", "hi")], hasMore: false }), { type: "provider", provider: "chatgpt" });
  assert.equal(kept.current?.id, 1);
});

test("opening a conversation restores its provider as the active one", () => {
  const s = reduceU({ ...initialU, provider: "chatgpt" }, { type: "opened", conversation: conv(5, "claude"), messages: [], hasMore: false });
  assert.equal(s.provider, "claude");
});

test("events of other conversations or stale generations are ignored", () => {
  let s = send({ ...initialU }, conv(1, "claude"), "x", 3);
  const before = s;
  s = reduceU(s, { type: "event", event: { type: "u_chat_delta", conversationId: 99, generation: 3, text: "stray" } });
  s = reduceU(s, { type: "event", event: { type: "u_chat_delta", conversationId: 1, generation: 2, text: "stale" } });
  assert.equal(s.stream, before.stream);
  s = reduceU(s, { type: "event", event: { type: "u_chat_failed", conversationId: 1, generation: 3, kind: "not_found", message: "Claude Code was not found" } });
  assert.equal(s.error?.message, "Claude Code was not found");
  assert.ok(!s.streaming);
  const cancelled = reduceU(send({ ...initialU }, conv(1, "claude"), "x"), { type: "event", event: { type: "u_chat_failed", conversationId: 1, generation: 1, kind: "cancelled", message: "Cancelled." } });
  assert.equal(cancelled.error, null);
});

test("titles update the list and the open conversation", () => {
  let s = reduceU({ ...initialU }, { type: "list", convs: [{ id: 1, title: "New conversation", provider: "chatgpt", model: "", updatedAt: 0, messageCount: 2, snippet: "" }] });
  s = reduceU(s, { type: "opened", conversation: conv(1, "chatgpt"), messages: [], hasMore: false });
  s = reduceU(s, { type: "event", event: { type: "u_chat_title", conversationId: 1, title: "SaaS ideas" } });
  assert.equal(s.convs[0]?.title, "SaaS ideas");
  assert.equal(s.current?.title, "SaaS ideas");
});

test("earlier pages are prepended without duplicates", () => {
  let s = reduceU({ ...initialU }, { type: "opened", conversation: conv(1, "claude"), messages: [msg(3, 1, "user", "c"), msg(4, 1, "assistant", "d")], hasMore: true });
  s = reduceU(s, { type: "older", messages: [msg(1, 1, "user", "a"), msg(2, 1, "assistant", "b"), msg(3, 1, "user", "c")], hasMore: false });
  assert.deepEqual(s.messages.map((m) => m.id), [1, 2, 3, 4]);
  assert.equal(s.hasMore, false);
});

test("universal chat state is independent of repository switches and has no project field", () => {
  const u: UState = send({ ...initialU }, conv(1, "claude"), "hello");
  // the repository-scoped state resets on a project switch; the universal state is a different object and is untouched
  const switched = reduce({ ...initialState, currentProjectId: 1 }, { type: "project_switched", projectId: 2 });
  assert.equal(switched.currentProjectId, 2);
  assert.equal(u.messages.length, 1);
  assert.ok(!Object.keys(u).some((k) => /project|repo/i.test(k)), Object.keys(u).join());
  assert.ok(!JSON.stringify(u).toLowerCase().includes("project"));
});

test("provider setting parsing defaults to ChatGPT", () => {
  assert.equal(parseProvider(undefined), "chatgpt");
  assert.equal(parseProvider("claude"), "claude");
  assert.equal(parseProvider("nonsense"), "chatgpt");
});
