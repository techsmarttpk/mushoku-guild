import { useCallback, useEffect, useRef, useState } from "react";
import { decorations, iconFor } from "../../domain/repo.ts";
import type { FileEntry, FsEntry } from "../../domain/types.ts";
import { api, toProviderError } from "../../ipc.ts";
import { ConfirmDialog, PromptDialog } from "./common.tsx";

type Dialog = { kind: "new-file" | "new-dir"; dir: string } | { kind: "rename"; entry: FsEntry } | { kind: "delete"; entry: FsEntry; important: boolean } | null;

/** Lazy tree of the real repository folder (every listing comes from Rust and respects the repository boundary). */
export function Explorer(props: {
  projectId: number;
  /** bumps when files may have changed (saves, Git operations, quests): the open folders are re-listed */
  refreshKey: number;
  entries: FileEntry[];
  activePath: string | null;
  onOpen: (rel: string) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (rel: string) => void;
  onError: (m: string) => void;
}) {
  const { projectId } = props;
  const [showHidden, setShowHidden] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [tree, setTree] = useState<Map<string, FsEntry[]>>(new Map());
  const [selected, setSelected] = useState<string>("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const dec = decorations(props.entries);

  const loadDir = useCallback(
    async (rel: string): Promise<FsEntry[] | null> => {
      try {
        const list = await api.fsList(projectId, rel, showHidden, showIgnored);
        setTree((t) => new Map(t).set(rel, list));
        return list;
      } catch (e) {
        props.onError(toProviderError(e).message);
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, showHidden, showIgnored],
  );

  const reloadAll = useCallback(async () => {
    const dirs = [...openRef.current];
    const out = new Map<string, FsEntry[]>();
    await Promise.all(
      dirs.map(async (d) => {
        try {
          out.set(d, await api.fsList(projectId, d, showHidden, showIgnored));
        } catch {
          /* the folder disappeared: it is dropped below */
        }
      }),
    );
    setTree(out);
    setOpen((o) => new Set([...o].filter((d) => out.has(d))));
  }, [projectId, showHidden, showIgnored]);

  useEffect(() => {
    setOpen(new Set([""]));
    setTree(new Map());
    setSelected("");
    void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => {
    void reloadAll();
  }, [props.refreshKey, showHidden, showIgnored, reloadAll]);

  const toggle = async (rel: string): Promise<void> => {
    if (open.has(rel)) {
      setOpen((o) => {
        const n = new Set(o);
        n.delete(rel);
        return n;
      });
      return;
    }
    if (await loadDir(rel)) setOpen((o) => new Set(o).add(rel));
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await reloadAll();
    } catch (e) {
      props.onError(toProviderError(e).message);
    }
  };

  const selectedEntry = (): FsEntry | null => {
    for (const list of tree.values()) {
      const f = list.find((e) => e.rel === selected);
      if (f) return f;
    }
    return null;
  };
  const targetDir = (): string => {
    const e = selectedEntry();
    if (!e) return "";
    return e.isDir ? e.rel : e.rel.includes("/") ? e.rel.slice(0, e.rel.lastIndexOf("/")) : "";
  };

  const row = (e: FsEntry, depth: number) => {
    const isOpen = e.isDir && open.has(e.rel);
    const d = dec.files.get(e.rel);
    const folderChanged = e.isDir && dec.folders.has(e.rel);
    return (
      <li key={e.rel}>
        <div
          className={`tree-row ${selected === e.rel ? "sel" : ""} ${props.activePath === e.rel ? "active" : ""} ${e.ignored ? "ignored" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          role="treeitem"
          aria-expanded={e.isDir ? isOpen : undefined}
          aria-selected={selected === e.rel}
          tabIndex={0}
          onClick={() => {
            setSelected(e.rel);
            if (e.isDir) void toggle(e.rel);
            else if (!e.link) props.onOpen(e.rel);
          }}
          onKeyDown={(k) => {
            if (k.key === "Enter") (k.currentTarget as HTMLElement).click();
            if (k.key === "F2") setDialog({ kind: "rename", entry: e });
            if (k.key === "Delete") setDialog({ kind: "delete", entry: e, important: false });
          }}
          title={e.link ? `${e.rel} (link, not followed)` : e.rel}
        >
          <span className="tree-icon" aria-hidden>
            {e.link ? "🔗" : iconFor(e.name, e.isDir, isOpen)}
          </span>
          <span className="tree-name">{e.name}</span>
          {d && <span className={`gl gl-${d.kind}`}>{d.letter}</span>}
          {folderChanged && !isOpen && <span className="gl gl-dot">●</span>}
        </div>
        {isOpen && <ul role="group">{(tree.get(e.rel) ?? []).map((c) => row(c, depth + 1))}</ul>}
      </li>
    );
  };

  const root = tree.get("") ?? [];
  const isImportant = (e: FsEntry): boolean => /^(\.gitignore|\.gitattributes|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?|go\.mod|CLAUDE\.md|README\.md|LICENSE|tsconfig\.json|docker-compose\.yml|Dockerfile)$/i.test(e.rel);

  return (
    <div className="explorer">
      <div className="explorer-bar">
        <button className="ib" title="New file" onClick={() => setDialog({ kind: "new-file", dir: targetDir() })}>
          ＋📄
        </button>
        <button className="ib" title="New folder" onClick={() => setDialog({ kind: "new-dir", dir: targetDir() })}>
          ＋📁
        </button>
        <button className="ib" title="Rename (F2)" disabled={!selectedEntry()} onClick={() => { const e = selectedEntry(); if (e) setDialog({ kind: "rename", entry: e }); }}>
          ✎
        </button>
        <button className="ib" title="Delete (Del)" disabled={!selectedEntry()} onClick={() => { const e = selectedEntry(); if (e) setDialog({ kind: "delete", entry: e, important: false }); }}>
          🗑
        </button>
        <button className="ib" title="Refresh the explorer" onClick={() => void reloadAll()}>
          ⟳
        </button>
      </div>
      <div className="explorer-opts">
        <label title="Show files that start with a dot">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> hidden
        </label>
        <label title="Show files matched by .gitignore">
          <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} /> ignored
        </label>
      </div>
      <ul className="tree" role="tree" aria-label="Repository files">
        {root.map((e) => row(e, 0))}
        {root.length === 0 && <li className="muted pad small">This folder is empty.</li>}
      </ul>

      {dialog && (dialog.kind === "new-file" || dialog.kind === "new-dir") && (
        <PromptDialog
          title={dialog.kind === "new-file" ? "New file" : "New folder"}
          label={`Name (inside ${dialog.dir || "the repository root"})`}
          confirm="Create"
          onCancel={() => setDialog(null)}
          onSubmit={(name) => {
            const d = dialog;
            setDialog(null);
            const rel = d.dir ? `${d.dir}/${name}` : name;
            void run(async () => {
              await api.fsCreate(projectId, rel, d.kind === "new-dir");
              if (d.dir) setOpen((o) => new Set(o).add(d.dir));
              if (d.kind === "new-file") props.onOpen(rel);
            });
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <PromptDialog
          title={`Rename ${dialog.entry.isDir ? "folder" : "file"}`}
          label="New name"
          initial={dialog.entry.name}
          confirm="Rename"
          onCancel={() => setDialog(null)}
          onSubmit={(name) => {
            const e = dialog.entry;
            setDialog(null);
            const parent = e.rel.includes("/") ? e.rel.slice(0, e.rel.lastIndexOf("/")) : "";
            const to = parent ? `${parent}/${name}` : name;
            void run(async () => {
              await api.fsRename(projectId, e.rel, to);
              props.onRenamed(e.rel, to);
            });
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${dialog.entry.isDir ? "folder" : "file"}?`}
          danger
          confirm="Delete permanently"
          message={
            <>
              <p>
                <strong>{dialog.entry.rel}</strong> will be deleted from disk{dialog.entry.isDir ? " together with everything inside it" : ""}. This cannot be undone from here (tracked files can be restored with Git).
              </p>
              {isImportant(dialog.entry) && <p className="warn-line">This is an important repository file.</p>}
            </>
          }
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const e = dialog.entry;
            setDialog(null);
            void run(async () => {
              await api.fsDelete(projectId, e.rel, isImportant(e));
              props.onDeleted(e.rel);
            });
          }}
        />
      )}
    </div>
  );
}
