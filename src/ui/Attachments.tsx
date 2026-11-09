import { useEffect, useRef, useState } from "react";
import { ACCEPT, LIMITS, SUPPORTED_TEXT, checkFiles, formatSize, kindOf, type AttachKind } from "../domain/attachments.ts";
import type { AttachmentView } from "../domain/types.ts";
import { api } from "../ipc.ts";

export interface Pending {
  key: number;
  file: File;
  kind: AttachKind;
  preview: string | null;
}

const ICON: Record<AttachKind, string> = { image: "🖼", text: "📄", pdf: "📕" };
let seq = 0;

/** The attachment section of the quest form: file picker, drag and drop, previews, sizes, remove. */
export function AttachmentPicker(props: { items: Pending[]; onChange: (items: Pending[]) => void; disabled?: boolean }) {
  const { items } = props;
  const [problems, setProblems] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () => () => {
      for (const p of itemsRef.current) if (p.preview) URL.revokeObjectURL(p.preview);
    },
    [],
  );

  const add = (files: File[]): void => {
    const verdict = checkFiles(items.map((p) => ({ name: p.file.name, size: p.file.size })), files.map((f) => ({ name: f.name, size: f.size })));
    const next: Pending[] = verdict.accepted.map((i) => {
      const file = files[i] as File;
      const kind = kindOf(file.name) as AttachKind;
      return { key: ++seq, file, kind, preview: kind === "image" ? URL.createObjectURL(file) : null };
    });
    setProblems(verdict.rejected.map((r) => `“${r.name}”: ${r.reason}`));
    if (next.length) props.onChange([...items, ...next]);
  };
  const remove = (key: number): void => {
    const gone = items.find((p) => p.key === key);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    props.onChange(items.filter((p) => p.key !== key));
    setProblems([]);
  };
  const total = items.reduce((n, p) => n + p.file.size, 0);

  return (
    <fieldset className="attach" disabled={props.disabled}>
      <legend>
        Attachments {items.length > 0 && <span className="pill">{items.length}</span>}
      </legend>
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(Array.from(e.dataTransfer.files));
        }}
      >
        <span>Drop screenshots or files here, or </span>
        <button type="button" className="btn" onClick={() => input.current?.click()}>
          Choose files…
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <small className="muted">
          {SUPPORTED_TEXT}. Up to {LIMITS.files} files; images {formatSize(LIMITS.image)}, PDFs {formatSize(LIMITS.pdf)}, text {formatSize(LIMITS.text)}.
        </small>
      </div>
      {problems.length > 0 && (
        <ul className="attach-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <>
          <ul className="attach-list">
            {items.map((p) => (
              <li key={p.key} className="attach-item">
                {p.preview ? <img src={p.preview} alt="" className="attach-thumb" /> : <span className="attach-icon" aria-hidden>{ICON[p.kind]}</span>}
                <span className="attach-name" title={p.file.name}>
                  {p.file.name}
                </span>
                <small className="muted">{formatSize(p.file.size)}</small>
                <button type="button" className="link" onClick={() => remove(p.key)} aria-label={`Remove ${p.file.name}`}>
                  remove
                </button>
              </li>
            ))}
          </ul>
          <small className="muted">
            {items.length} attached · {formatSize(total)}. Copies are stored by Mushoku Guild; your originals are never changed. Claude sees images and PDFs directly.
          </small>
        </>
      )}
    </fieldset>
  );
}

/** Attachments of an opened quest (read-only, with image previews). */
export function AttachmentStrip({ taskId }: { taskId: number }) {
  const [items, setItems] = useState<AttachmentView[]>([]);
  const [previews, setPreviews] = useState<Record<number, string>>({});
  useEffect(() => {
    let live = true;
    setItems([]);
    setPreviews({});
    void api.attachmentList(taskId).then(
      (list) => {
        if (!live) return;
        setItems(list);
        for (const a of list.filter((x) => x.kind === "image")) {
          void api.attachmentPreview(taskId, a.id).then(
            (url) => live && setPreviews((p) => ({ ...p, [a.id]: url })),
            () => undefined,
          );
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [taskId]);
  if (items.length === 0) return null;
  return (
    <section className="card attach-strip">
      <h3>
        Attachments <span className="pill">{items.length}</span>
      </h3>
      <ul className="attach-list">
        {items.map((a) => (
          <li key={a.id} className="attach-item">
            {previews[a.id] ? <img src={previews[a.id]} alt={a.name} className="attach-thumb" /> : <span className="attach-icon" aria-hidden>{ICON[a.kind]}</span>}
            <span className="attach-name">{a.name}</span>
            <small className="muted">{formatSize(a.size)}</small>
          </li>
        ))}
      </ul>
      <small className="muted">Claude Code receives these with the approved prompt. They add no permissions.</small>
    </section>
  );
}
