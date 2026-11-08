// Small lossless syntax highlighter for fenced code in documents. It never rewrites text: joining the tokens
// always gives back the input, so it cannot hide or change what a document says.

export type Tok = { t: "kw" | "str" | "com" | "num" | "txt"; s: string };

const KEYWORDS: Record<string, string[]> = {
  ts: "const let var function return if else for while switch case break continue new class extends implements interface type enum import export from as default async await try catch finally throw typeof instanceof void null undefined true false this super in of readonly public private protected static".split(" "),
  rust: "fn let mut const static struct enum impl trait pub use mod crate self super match if else for while loop return break continue as in where async await move ref dyn unsafe type true false Some None Ok Err".split(" "),
  py: "def class return if elif else for while import from as with try except finally raise pass break continue lambda yield async await None True False in not and or is global nonlocal".split(" "),
  sh: "if then else elif fi for do done while case esac function export echo cd git npm pnpm cargo node sudo".split(" "),
  json: ["true", "false", "null"],
  css: "important".split(" "),
  sql: "select from where insert into values update set delete create table index primary key join left right inner outer on group by order limit and or not null as".split(" "),
};
const ALIAS: Record<string, string> = { js: "ts", jsx: "ts", tsx: "ts", javascript: "ts", typescript: "ts", mjs: "ts", rs: "rust", python: "py", bash: "sh", shell: "sh", powershell: "sh", ps1: "sh", yaml: "sh", yml: "sh", toml: "sh", jsonc: "json", sqlite: "sql" };

export function languageOf(lang: string): string | null {
  const l = lang.trim().toLowerCase();
  const k = ALIAS[l] ?? l;
  return k in KEYWORDS ? k : null;
}

export function highlight(code: string, lang: string): Tok[] {
  const k = languageOf(lang);
  if (!k) return [{ t: "txt", s: code }];
  const kws = new Set(KEYWORDS[k]);
  const lineComment = k === "py" || k === "sh" ? "#" : k === "sql" ? "--" : k === "json" || k === "css" ? "" : "//";
  const parts = [
    lineComment ? `(?<com>${lineComment.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}[^\\n]*)` : "(?<com>(?!))",
    k === "css" || k === "ts" || k === "rust" ? "(?<mc>/\\*[\\s\\S]*?\\*/)" : "(?<mc>(?!))",
    "(?<str>\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)",
    "(?<num>\\b\\d[\\d_.]*\\b)",
    "(?<word>[A-Za-z_][A-Za-z0-9_]*)",
  ];
  const re = new RegExp(parts.join("|"), "g");
  const out: Tok[] = [];
  let last = 0;
  const push = (t: Tok["t"], s: string): void => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev && prev.t === t) prev.s += s;
    else out.push({ t, s });
  };
  for (const m of code.matchAll(re)) {
    const idx = m.index ?? 0;
    push("txt", code.slice(last, idx));
    const g = m.groups ?? {};
    if (g["com"] !== undefined || g["mc"] !== undefined) push("com", m[0]);
    else if (g["str"] !== undefined) push("str", m[0]);
    else if (g["num"] !== undefined) push("num", m[0]);
    else if (g["word"] !== undefined && kws.has(k === "sql" ? m[0].toLowerCase() : m[0])) push("kw", m[0]);
    else push("txt", m[0]);
    last = idx + m[0].length;
  }
  push("txt", code.slice(last));
  return out;
}
