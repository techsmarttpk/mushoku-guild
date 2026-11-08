import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight, languageOf } from "./highlight.ts";

const join = (t: { s: string }[]) => t.map((x) => x.s).join("");

test("highlighting is lossless for every supported language and for odd input", () => {
  const samples: Array<[string, string]> = [
    ["ts", 'const a = "x\\"y"; // note\nfunction f(n: number) { return n * 2; } /* c */'],
    ["rust", 'fn main() { let s = "hi"; /* a */ println!("{}", 1_000); } // end'],
    ["py", "def f(x):\n    return 'a' + str(x)  # c"],
    ["sh", "cargo test # run\necho \"done\""],
    ["json", '{"a": [1, true, null], "b": "c"}'],
    ["unknown", "whatever <b>text</b> `x`"],
    ["ts", "unterminated 'string and `template"],
    ["ts", ""],
  ];
  for (const [lang, code] of samples) assert.equal(join(highlight(code, lang)), code, lang);
});

test("keywords, strings and comments are classified; unknown languages stay plain", () => {
  const t = highlight('const x = "hi"; // done', "ts");
  assert.deepEqual(t.filter((x) => x.t !== "txt").map((x) => [x.t, x.s]), [["kw", "const"], ["str", '"hi"'], ["com", "// done"]]);
  assert.deepEqual(highlight("const x", "brainfuck"), [{ t: "txt", s: "const x" }]);
  assert.equal(languageOf("TSX"), "ts");
  assert.equal(languageOf("rs"), "rust");
  assert.equal(languageOf(""), null);
});
