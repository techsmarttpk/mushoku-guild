import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BUDGETS, DEFAULT_MODE, MODES, budgetFor, formatTokens, modesFor, sanitizeMode, sizeLabel, thirdPartyWarning } from "./context.ts";

test("No Context is always available and is the Universal Chat default", () => {
  for (const s of ["quest", "chat", "uchat"] as const) assert.ok(modesFor(s).includes("none"), s);
  assert.equal(DEFAULT_MODE.uchat, "none");
  assert.equal(sanitizeMode("uchat", undefined), "none");
});

test("new users get the lightweight capsule on quests and Guild Chat, never Deep Research", () => {
  assert.equal(DEFAULT_MODE.quest, "capsule");
  assert.equal(DEFAULT_MODE.chat, "capsule");
  for (const s of ["quest", "chat", "uchat"] as const) {
    assert.notEqual(DEFAULT_MODE[s], "deep");
    assert.notEqual(sanitizeMode(s, "deep"), "deep", "Deep Research is never restored from storage");
    assert.equal(sanitizeMode(s, "garbage"), DEFAULT_MODE[s]);
  }
});

test("last-used choices are restored for the surfaces that offer them", () => {
  assert.equal(sanitizeMode("quest", "none"), "none");
  assert.equal(sanitizeMode("chat", "relevant"), "relevant");
  assert.equal(sanitizeMode("uchat", "relevant"), "relevant");
});

test("only Deep Research starts Claude Code, and Universal Chat cannot choose it", () => {
  assert.deepEqual(
    (Object.keys(MODES) as Array<keyof typeof MODES>).filter((m) => MODES[m].invokesClaude),
    ["deep"],
  );
  assert.ok(!modesFor("uchat").includes("deep"));
  assert.ok(MODES.deep.hint.includes("Claude Code"));
});

test("the size indicator is honest about each mode", () => {
  assert.equal(sizeLabel("none", 0, false), "nothing from the project is sent");
  assert.match(sizeLabel("capsule", 920, false), /920 tokens|~9[0-9]0 tokens/);
  assert.match(sizeLabel("relevant", 3400, false), /3\.4k tokens/);
  assert.equal(sizeLabel("relevant", null, true), "estimating…");
  assert.match(sizeLabel("deep", 900, false), /Claude Code findings/);
  assert.equal(formatTokens(0), "0 tokens");
});

test("budgets follow the stated defaults", () => {
  assert.deepEqual(DEFAULT_BUDGETS, { capsule: 1000, relevant: 4000 });
  assert.equal(budgetFor("none", DEFAULT_BUDGETS), 0);
  assert.equal(budgetFor("capsule", DEFAULT_BUDGETS), 1000);
  assert.equal(budgetFor("relevant", DEFAULT_BUDGETS), 5000);
  assert.equal(budgetFor("deep", DEFAULT_BUDGETS), null);
});

test("project text going to a third-party model carries a warning; No Context and local providers do not", () => {
  assert.equal(thirdPartyWarning("openrouter", "none"), null);
  assert.match(thirdPartyWarning("openrouter", "capsule") ?? "", /third party/);
  assert.equal(thirdPartyWarning("claude", "relevant"), null);
});
