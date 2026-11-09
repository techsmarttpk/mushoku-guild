import assert from "node:assert/strict";
import { test } from "node:test";
import { filterDocs } from "./library.ts";
import { CLOSED, reduceLibSearch } from "./libSearch.ts";
import type { LibraryMeta } from "./types.ts";

const docs: LibraryMeta[] = [
  { path: "docs/a.md", title: "Alpha", size: 1, modified: 0 },
  { path: "docs/b.md", title: "Beta", size: 1, modified: 0 },
];

test("search is hidden until the button is used, and the full shelf shows meanwhile", () => {
  assert.deepEqual(CLOSED, { open: false, query: "" });
  assert.equal(filterDocs(docs, CLOSED.query).length, 2);
  const open = reduceLibSearch(CLOSED, { type: "open" });
  assert.ok(open.open);
});

test("typing filters; clearing keeps the field open; closing restores the full shelf", () => {
  let s = reduceLibSearch(CLOSED, { type: "open" });
  s = reduceLibSearch(s, { type: "type", query: "alp" });
  assert.equal(filterDocs(docs, s.query).length, 1);
  s = reduceLibSearch(s, { type: "clear" });
  assert.ok(s.open && s.query === "");
  assert.equal(filterDocs(docs, s.query).length, 2);
  s = reduceLibSearch(reduceLibSearch(s, { type: "type", query: "zzz" }), { type: "close" });
  assert.deepEqual(s, CLOSED);
  assert.equal(filterDocs(docs, s.query).length, 2);
});

test("leaving an empty field closes it; a field with text stays open", () => {
  assert.deepEqual(reduceLibSearch({ open: true, query: "" }, { type: "blur" }), CLOSED);
  assert.deepEqual(reduceLibSearch({ open: true, query: "  " }, { type: "blur" }), CLOSED);
  const keep = { open: true, query: "alp" };
  assert.deepEqual(reduceLibSearch(keep, { type: "blur" }), keep);
});
