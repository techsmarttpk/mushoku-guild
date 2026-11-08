// Tiny Markdown parser for chat replies: headings, fenced code, lists, quotes, paragraphs and inline code/bold/italic.
// It produces data, not HTML; React renders it as elements, so model output can never inject markup or links.

export type Inline = { t: "text" | "code" | "b" | "i"; s: string };
export type Block =
  | { k: "h"; level: number; inline: Inline[] }
  | { k: "p"; inline: Inline[] }
  | { k: "code"; lang: string; text: string }
  | { k: "ul" | "ol"; items: Inline[][] }
  | { k: "quote"; inline: Inline[] }
  | { k: "hr" };

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ t: "text", s: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", s: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: "b", s: (m[2] ?? m[3]) as string });
    else if (m[4] !== undefined) out.push({ t: "i", s: m[4] });
    else out.push({ t: "text", s: `${m[5] ?? ""} (${m[6] ?? ""})` }); // links are shown as text, never as anchors
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: "text", s: src.slice(last) });
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) blocks.push({ k: "p", inline: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      blocks.push({ k: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ k: "h", level: (h[1] ?? "#").length, inline: parseInline(h[2] ?? "") });
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush();
      blocks.push({ k: "hr" });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1] ?? "");
      const items: Inline[][] = [parseInline(li[2] ?? "")];
      while (i + 1 < lines.length) {
        const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1] ?? "");
        if (!next || /\d/.test(next[1] ?? "") !== ordered) break;
        items.push(parseInline(next[2] ?? ""));
        i++;
      }
      blocks.push({ k: ordered ? "ol" : "ul", items });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      blocks.push({ k: "quote", inline: parseInline(q[1] ?? "") });
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
