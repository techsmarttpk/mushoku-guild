import assert from "node:assert/strict";
import { test } from "node:test";
import { filterDocs, matchSummary } from "./library.ts";
import type { LibraryMeta } from "./types.ts";

const doc = (path: string, title: string): LibraryMeta => ({ path, title, size: 1000, modified: 0 });
const DOCS = [
  doc("CLAUDE.md", "Mushoku Guild Engineering Constitution"),
  doc("docs/ARCHITECTURE.md", "Architecture"),
  doc("docs/system-design.md", "System design: HLD and LLD"),
  doc("docs/measurements/phase2/README.md", "Phase 2 measurements"),
  doc("docs/GIT_WORKBENCH.md", "Git Workbench"),
];

test("an empty query shows every book in shelf order", () => {
  assert.equal(filterDocs(DOCS, "").length, 5);
  assert.equal(filterDocs(DOCS, "   ").length, 5);
});

test("search by title", () => {
  assert.deepEqual(filterDocs(DOCS, "constitution").map((d) => d.path), ["CLAUDE.md"]);
  assert.deepEqual(filterDocs(DOCS, "HLD").map((d) => d.path), ["docs/system-design.md"]);
});

test("search by file name, including partial names", () => {
  assert.deepEqual(filterDocs(DOCS, "git_work").map((d) => d.path), ["docs/GIT_WORKBENCH.md"]);
  assert.deepEqual(filterDocs(DOCS, "readme").map((d) => d.path), ["docs/measurements/phase2/README.md"]);
});

test("search by relative path, with either slash style", () => {
  assert.equal(filterDocs(DOCS, "measurements/phase2").length, 1);
  assert.equal(filterDocs(DOCS, "measurements\\phase2").length, 1);
  assert.equal(filterDocs(DOCS, "docs/").length, 4);
});

test("matching is case-insensitive and every term must match", () => {
  assert.deepEqual(filterDocs(DOCS, "ARCHITECTURE").map((d) => d.path), ["docs/ARCHITECTURE.md"]);
  assert.deepEqual(filterDocs(DOCS, "arch").map((d) => d.path), ["docs/ARCHITECTURE.md"]);
  assert.deepEqual(filterDocs(DOCS, "docs sys").map((d) => d.path), ["docs/system-design.md"]);
  assert.equal(filterDocs(DOCS, "docs nothing-like-this").length, 0);
});

test("no match gives an empty list and the summary says so", () => {
  const none = filterDocs(DOCS, "zzz");
  assert.equal(none.length, 0);
  assert.equal(matchSummary(0, 5, "zzz"), "0 of 5 books match");
  assert.equal(matchSummary(1, 1, "a"), "1 of 1 book match");
  assert.equal(matchSummary(5, 5, ""), "5 books on the shelves");
});

test("search stays fast on a large collection", () => {
  const big = Array.from({ length: 5000 }, (_, i) => doc(`docs/section-${i % 50}/file-${i}.md`, `Document number ${i}`));
  const t0 = performance.now();
  const hit = filterDocs(big, "section-7 file-4");
  assert.ok(performance.now() - t0 < 250);
  assert.ok(hit.length > 0 && hit.every((d) => d.path.includes("section-7/")));
});
