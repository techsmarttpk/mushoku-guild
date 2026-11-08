// CodeMirror 6 setup for the Repo tab. This whole module is loaded lazily (dynamic import) the first time the Repo
// tab opens, and each language pack is loaded only when a file of that language is opened. No language server and
// no background process: highlighting, completion and search all run inside the editor.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension, type Text } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export interface EditorHandlers {
  onDirty: (rel: string, dirty: boolean) => void;
  onCursor: (line: number, col: number) => void;
  onSave: () => void;
  onSaveAll: () => void;
}

export interface EditorController {
  open(rel: string, content: string, lang: string): Promise<void>;
  show(rel: string): void;
  text(rel: string): string | null;
  replace(rel: string, content: string): void;
  markSaved(rel: string): void;
  close(rel: string): void;
  setWrap(on: boolean): void;
  focus(): void;
  destroy(): void;
}

const palette = { bg: "#1b110b", fg: "#f5e6c4", gutter: "#8a6a4a", sel: "#5c3a22", cursor: "#f0b93a", line: "#2c1b11" };

const theme = EditorView.theme(
  {
    "&": { height: "100%", color: palette.fg, backgroundColor: palette.bg, fontSize: "14px" },
    ".cm-scroller": { fontFamily: 'Consolas, "Cascadia Mono", "Lucida Console", monospace', lineHeight: "1.45" },
    ".cm-content": { caretColor: palette.cursor },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: palette.cursor, borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: palette.sel },
    ".cm-gutters": { backgroundColor: "#140c07", color: palette.gutter, border: "none", borderRight: "2px solid #3d2618" },
    ".cm-activeLine": { backgroundColor: palette.line },
    ".cm-activeLineGutter": { backgroundColor: palette.line, color: palette.fg },
    ".cm-matchingBracket": { backgroundColor: "#4a3a1a", outline: "1px solid #f0b93a" },
    ".cm-searchMatch": { backgroundColor: "#6a5a1a" },
    ".cm-searchMatch-selected": { backgroundColor: "#a07a1a" },
    ".cm-panels": { backgroundColor: "#2c1b11", color: palette.fg, borderColor: "#5c3a22" },
    ".cm-panels input, .cm-panels button": { fontFamily: "inherit", fontSize: "14px" },
    ".cm-panels input": { backgroundColor: "#140c07", color: palette.fg, border: "1px solid #5c3a22" },
    ".cm-panels button": { backgroundColor: "#5c3a22", color: palette.fg, border: "1px solid #8a5a34", backgroundImage: "none" },
    ".cm-tooltip": { backgroundColor: "#2c1b11", color: palette.fg, border: "1px solid #5c3a22" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "#5c3a22", color: palette.fg },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.operatorKeyword], color: "#f0b93a" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#8fd36a" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#8d8d8d", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#7fc4f0" },
  { tag: [t.typeName, t.className, t.namespace], color: "#3cc0bb" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#e8c98a" },
  { tag: [t.propertyName, t.attributeName], color: "#d9a066" },
  { tag: [t.tagName, t.angleBracket], color: "#e0584d" },
  { tag: [t.heading], color: "#f0b93a", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#7fc4f0", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.invalid], color: "#e0584d" },
]);

async function languageSupport(lang: string): Promise<Extension | null> {
  switch (lang) {
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "toml":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "shell":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "kotlin":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).kotlin);
    case "c":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).c);
    case "cpp":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).cpp);
    case "csharp":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp);
    case "go":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go);
    case "ruby":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby);
    case "php":
      return (await import("@codemirror/lang-html")).html();
    default:
      return null;
  }
}

export type { LanguageSupport };

interface Held {
  state: EditorState;
  saved: Text;
}

export function createEditor(host: HTMLElement, h: EditorHandlers): EditorController {
  const wrapComp = new Compartment();
  const held = new Map<string, Held>();
  let active: string | null = null;
  let wrapOn = false;

  const base = (): Extension[] => [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    indentOnInput(),
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    wrapComp.of(wrapOn ? EditorView.lineWrapping : []),
    Prec.highest(
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (h.onSave(), true) },
        { key: "Mod-Shift-s", preventDefault: true, run: () => (h.onSaveAll(), true) },
      ]),
    ),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    theme,
    EditorView.updateListener.of((u) => {
      if (!active) return;
      if (u.docChanged) {
        const hd = held.get(active);
        if (hd) h.onDirty(active, !u.state.doc.eq(hd.saved));
      }
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        h.onCursor(line.number, head - line.from + 1);
      }
    }),
  ];

  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "", extensions: [...base(), EditorState.readOnly.of(true)] }) });

  const stash = (): void => {
    if (active) {
      const hd = held.get(active);
      if (hd) hd.state = view.state;
    }
  };

  return {
    async open(rel, content, lang) {
      const lng = await languageSupport(lang);
      const state = EditorState.create({ doc: content, extensions: [...base(), ...(lng ? [lng] : [])] });
      held.set(rel, { state, saved: state.doc });
    },
    show(rel) {
      const hd = held.get(rel);
      if (!hd) return;
      stash();
      active = rel;
      view.setState(hd.state);
      const head = hd.state.selection.main.head;
      const line = hd.state.doc.lineAt(head);
      h.onCursor(line.number, head - line.from + 1);
    },
    text(rel) {
      if (rel === active) return view.state.doc.toString();
      return held.get(rel)?.state.doc.toString() ?? null;
    },
    replace(rel, content) {
      const hd = held.get(rel);
      if (!hd) return;
      if (rel === active) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        hd.state = view.state;
        hd.saved = view.state.doc;
        h.onDirty(rel, false);
      } else {
        const tr = hd.state.update({ changes: { from: 0, to: hd.state.doc.length, insert: content } });
        hd.state = tr.state;
        hd.saved = tr.state.doc;
      }
    },
    markSaved(rel) {
      const hd = held.get(rel);
      if (!hd) return;
      if (rel === active) hd.state = view.state;
      hd.saved = hd.state.doc;
      h.onDirty(rel, false);
    },
    close(rel) {
      held.delete(rel);
      if (active === rel) {
        active = null;
        view.setState(EditorState.create({ doc: "", extensions: [...base(), EditorState.readOnly.of(true)] }));
      }
    },
    setWrap(on) {
      wrapOn = on;
      view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) });
      // other tabs keep their own configuration until they are shown again; reconfigure them lazily
      for (const [rel, hd] of held) if (rel !== active) hd.state = hd.state.update({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }).state;
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
