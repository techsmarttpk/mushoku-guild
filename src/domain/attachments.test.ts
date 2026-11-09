import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, checkFiles, formatSize, kindOf } from "./attachments.ts";

test("every requested type is supported, case-insensitively", () => {
  for (const n of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif", "a.txt", "a.LOG", "a.pdf", "a.md", "a.markdown"]) assert.ok(kindOf(n), n);
  assert.equal(kindOf("shot.PNG"), "image");
  assert.equal(kindOf("trace.log"), "text");
  assert.equal(kindOf("spec.pdf"), "pdf");
  for (const n of ["a.exe", "a.svg", "a.zip", "noext", "a.png.exe", "a."]) assert.equal(kindOf(n), null, n);
});

test("unsupported files are rejected with a clear reason and the rest still go through", () => {
  const v = checkFiles([], [{ name: "ok.png", size: 1000 }, { name: "run.exe", size: 10 }, { name: "empty.txt", size: 0 }]);
  assert.deepEqual(v.accepted, [0]);
  assert.equal(v.rejected.length, 2);
  assert.match(v.rejected[0]!.reason, /not a supported file type/);
  assert.match(v.rejected[1]!.reason, /empty/);
});

test("size limits are per type", () => {
  assert.equal(checkFiles([], [{ name: "a.png", size: LIMITS.image }]).accepted.length, 1);
  assert.match(checkFiles([], [{ name: "a.png", size: LIMITS.image + 1 }]).rejected[0]!.reason, /too large/);
  assert.equal(checkFiles([], [{ name: "a.pdf", size: LIMITS.pdf }]).accepted.length, 1);
  assert.equal(checkFiles([], [{ name: "a.pdf", size: LIMITS.pdf + 1 }]).accepted.length, 0);
  assert.equal(checkFiles([], [{ name: "a.log", size: LIMITS.text + 1 }]).accepted.length, 0);
});

test("multiple attachments are allowed up to the file count and total size", () => {
  const eight = Array.from({ length: LIMITS.files }, (_, i) => ({ name: `f${i}.txt`, size: 10 }));
  assert.equal(checkFiles([], eight).accepted.length, LIMITS.files);
  const v = checkFiles(eight, [{ name: "one-more.txt", size: 10 }]);
  assert.match(v.rejected[0]!.reason, /at most 8/);
  const heavy = [{ name: "a.pdf", size: LIMITS.pdf }, { name: "b.pdf", size: LIMITS.pdf }];
  const v2 = checkFiles(heavy, [{ name: "c.png", size: LIMITS.image }]);
  assert.match(v2.rejected[0]!.reason, /in total/);
  const v3 = checkFiles([], [{ name: "a.pdf", size: LIMITS.pdf }, { name: "b.pdf", size: LIMITS.pdf - 1000 }, { name: "c.png", size: 100 }]);
  assert.deepEqual(v3.accepted, [0, 1, 2]);
});

test("sizes read naturally", () => {
  assert.equal(formatSize(100), "1 KB");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MB");
});
