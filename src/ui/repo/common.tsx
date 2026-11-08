// Small shared widgets of the Repo tab: dialogs (in-app, never window.prompt/confirm), dropdown menu, editor host.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { EditorController } from "./editorKit.ts";

export function PromptDialog(props: { title: string; label: string; initial?: string; placeholder?: string; confirm?: string; multiline?: boolean; onSubmit: (value: string) => void; onCancel: () => void; extra?: ReactNode }) {
  const [v, setV] = useState(props.initial ?? "");
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={props.title}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) props.onSubmit(v.trim());
        }}
      >
        <h3>{props.title}</h3>
        <label className="field">
          {props.label}
          {props.multiline ? <textarea autoFocus rows={4} value={v} placeholder={props.placeholder} onChange={(e) => setV(e.target.value)} /> : <input autoFocus value={v} placeholder={props.placeholder} onChange={(e) => setV(e.target.value)} />}
        </label>
        {props.extra}
        <div className="row">
          <button type="button" className="btn btn-quiet" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!v.trim()}>
            {props.confirm ?? "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog(props: { title: string; message: ReactNode; confirm: string; danger?: boolean; secondary?: { label: string; onClick: () => void }; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="overlay" role="alertdialog" aria-modal="true" aria-label={props.title}>
      <div className="dialog">
        <h3>{props.title}</h3>
        <div>{props.message}</div>
        <div className="row">
          <button ref={ref} className="btn btn-quiet" onClick={props.onCancel}>
            Cancel
          </button>
          {props.secondary && (
            <button className="btn" onClick={props.secondary.onClick}>
              {props.secondary.label}
            </button>
          )}
          <button className={`btn ${props.danger ? "btn-danger" : "btn-primary"}`} onClick={props.onConfirm}>
            {props.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A button that opens a small list of actions. */
export function Menu(props: { label: ReactNode; title?: string; items: Array<{ label: string; onClick: () => void; danger?: boolean; disabled?: boolean } | "sep">; className?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="menu" ref={box}>
      <button className={props.className ?? "btn"} title={props.title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {props.label}
      </button>
      {open && (
        <ul className={`menu-list ${props.align === "right" ? "right" : ""}`} role="menu">
          {props.items.map((it, i) =>
            it === "sep" ? (
              <li key={i} className="menu-sep" />
            ) : (
              <li key={i}>
                <button
                  role="menuitem"
                  className={it.danger ? "danger" : ""}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                >
                  {it.label}
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

export interface EditorApi {
  ensure(rel: string, content: string, lang: string): Promise<void>;
  show(rel: string): void;
  text(rel: string): string | null;
  replace(rel: string, content: string): void;
  markSaved(rel: string): void;
  close(rel: string): void;
  setWrap(on: boolean): void;
  focus(): void;
}

/** Hosts the CodeMirror editor. The editor code is fetched only when this component first mounts. */
export const EditorHost = forwardRef<EditorApi, { onDirty: (rel: string, d: boolean) => void; onCursor: (l: number, c: number) => void; onSave: () => void; onSaveAll: () => void }>(function EditorHost(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const ctl = useRef<Promise<EditorController> | null>(null);
  const ready = useRef<EditorController | null>(null);
  const handlers = useRef(props);
  handlers.current = props;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const p = import("./editorKit.ts").then((k) => {
      const c = k.createEditor(el, {
        onDirty: (r, d) => handlers.current.onDirty(r, d),
        onCursor: (l, c2) => handlers.current.onCursor(l, c2),
        onSave: () => handlers.current.onSave(),
        onSaveAll: () => handlers.current.onSaveAll(),
      });
      ready.current = c;
      return c;
    });
    ctl.current = p;
    return () => {
      void p.then((c) => c.destroy());
      ctl.current = null;
      ready.current = null;
    };
  }, []);
  useImperativeHandle(ref, () => {
    const use = async (f: (c: EditorController) => void | Promise<void>): Promise<void> => {
      const c = await ctl.current;
      if (c) await f(c);
    };
    return {
      ensure: (rel, content, lang) => use((c) => c.open(rel, content, lang)),
      show: (rel) => void use((c) => c.show(rel)),
      text: (rel) => ready.current?.text(rel) ?? null,
      replace: (rel, content) => void use((c) => c.replace(rel, content)),
      markSaved: (rel) => void use((c) => c.markSaved(rel)),
      close: (rel) => void use((c) => c.close(rel)),
      setWrap: (on) => void use((c) => c.setWrap(on)),
      focus: () => void use((c) => c.focus()),
    };
  }, []);
  return <div ref={host} className="editor-host" />;
});
