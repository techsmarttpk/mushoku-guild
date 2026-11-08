import assert from "node:assert/strict";
import { test } from "node:test";
import { isMermaid, parseInline, parseMarkdown } from "./markdown.ts";

test("code fences keep their content verbatim, including markdown-looking text and unterminated fences", () => {
  const b = parseMarkdown("Intro\n\n```ts\nconst a = **1**;\n# not a heading\n```\nafter");
  assert.deepEqual(b.map((x) => x.k), ["p", "code", "p"]);
  assert.deepEqual(b[1], { k: "code", lang: "ts", text: "const a = **1**;\n# not a heading" });
  assert.equal(parseMarkdown("```\nopen forever")[0]?.k, "code");
});

test("headings, lists and quotes", () => {
  const b = parseMarkdown("## Plan\n- one\n- two\n\n1. first\n2. second\n> note");
  assert.deepEqual(b.map((x) => x.k), ["h", "ul", "ol", "quote"]);
  assert.equal((b[1] as { items: unknown[] }).items.length, 2);
});

test("inline code, bold, italic; links become plain text and HTML stays inert text", () => {
  assert.deepEqual(parseInline("use `npm test` **now** and *later*"), [
    { t: "text", s: "use " }, { t: "code", s: "npm test" }, { t: "text", s: " " }, { t: "b", s: "now" }, { t: "text", s: " and " }, { t: "i", s: "later" },
  ]);
  assert.deepEqual(parseInline("[docs](https://example.com)"), [{ t: "text", s: "docs (https://example.com)" }]);
  assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [{ t: "text", s: "<img src=x onerror=alert(1)>" }]);
});

test("tables become structured data with their header and rows", () => {
  const b = parseMarkdown("Intro\n\n| Name | Role |\n|------|:----:|\n| `a` | **first** |\n| b | second |\n\nafter");
  assert.deepEqual(b.map((x) => x.k), ["p", "table", "p"]);
  const t = b[1] as { head: unknown[]; rows: unknown[][] };
  assert.equal(t.head.length, 2);
  assert.equal(t.rows.length, 2);
  assert.equal(parseMarkdown("a | b\nnot a table").some((x) => x.k === "table"), false);
});

test("only mermaid fences are diagrams; ordinary and lookalike fences stay code", () => {
  const doc = ["```mermaid", "flowchart TD", "  A[Start] --> B[Process]", "```", "", "```js", "const x = 1;", "```", "", "```mermaid-not", "x", "```", "", "```", "plain", "```", "", "```Mermaid", "sequenceDiagram", "  A->>B: hi", "```"].join("\n");
  const blocks = parseMarkdown(doc);
  const codes = blocks.filter((b): b is Extract<typeof b, { k: "code" }> => b.k === "code");
  assert.equal(codes.length, 5);
  assert.deepEqual(codes.map((c) => isMermaid(c.lang)), [true, false, false, false, true]);
  assert.match(codes[0]?.text ?? "", /A\[Start\] --> B\[Process\]/, "diagram source is preserved exactly");
  assert.equal(codes.filter((c) => isMermaid(c.lang)).length, 2, "several diagrams in one document are all found");
});
