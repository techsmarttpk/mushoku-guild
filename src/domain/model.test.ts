import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_LABEL, modelChoice } from "./types.ts";

test("unset or unknown model settings resolve to Sonnet, never Opus", () => {
  assert.equal(modelChoice(undefined), "sonnet");
  assert.equal(modelChoice(""), "sonnet");
  assert.equal(modelChoice("claude-opus-5-5"), "sonnet");
});

test("every choice has a label and persisted values round-trip", () => {
  for (const m of ["sonnet", "opus", "haiku", "default"] as const) {
    assert.equal(modelChoice(m), m);
    assert.ok(MODEL_LABEL[m].length > 0);
  }
  assert.equal(MODEL_LABEL.default, "CLI default");
});
