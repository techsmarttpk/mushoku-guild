import { useState } from "react";
import type { DocContent, LibraryMeta, Project } from "../domain/types.ts";
import { Markdown } from "./ChatPanel.tsx";
import { RepoTag } from "./Extras.tsx";

/** Right-hand side of the Library: the parchment reading view, or the shelf summary. */
export function LibraryReader(props: {
  project: Project | null;
  docs: LibraryMeta[];
  hover: LibraryMeta | null;
  doc: DocContent | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  currentConversationTitle: string | null;
  onBack: () => void;
  onRefreshDoc: () => void;
  onRefreshShelves: () => void;
  onAsk: (useCurrent: boolean) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const { doc, project } = props;
  if (!project) return <div className="note">Connect a project folder in the Guild tab first. The Library shows that repository's Markdown documentation as books.</div>;
  if (!doc) {
    return (
      <div className="stack">
        <div className="chat-head">
          <h3>Library</h3>
          <RepoTag project={project} />
        </div>
        {props.docs.length === 0 ? (
          <div className="empty-shelf">
            <p>The shelves are empty, adventurer. Your documentation awaits!</p>
            <p className="muted small">The Library lists CLAUDE.md, other Markdown files in the repository root, and every Markdown file under docs/.</p>
            <button className="btn btn-primary" onClick={props.onRefreshShelves}>
              Refresh shelves
            </button>
          </div>
        ) : (
          <>
            <p className="muted">
              {props.docs.length} {props.docs.length === 1 ? "book" : "books"} on the shelves. Click a book to read it; use the arrow keys and Enter to browse; scroll the shelves with the mouse wheel.
            </p>
            {props.hover && (
              <div className="card">
                <strong>{props.hover.title}</strong>
                <div className="muted small mono">{props.hover.path}</div>
                <div className="muted small">
                  {Math.max(1, Math.round(props.hover.size / 1024))} KB · modified {new Date(props.hover.modified).toLocaleDateString()}
                </div>
              </div>
            )}
            <button className="btn" onClick={props.onRefreshShelves}>
              Refresh shelves
            </button>
          </>
        )}
        {props.error && <div className="note note-error">{props.error}</div>}
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="row">
        <button className="btn" onClick={props.onBack}>
          ← Back to bookshelf
        </button>
        <button className="btn btn-quiet" onClick={props.onRefreshDoc} disabled={props.loading}>
          Refresh document
        </button>
      </div>
      <article className="parchment">
        <header>
          <h3>{doc.title}</h3>
          <div className="parchment-meta">
            <RepoTag project={project} /> <span className="mono">{doc.path}</span> <span>· modified {new Date(doc.modified).toLocaleString()}</span>
          </div>
        </header>
        {doc.truncated && <div className="note">This document is very long; only the first part is shown.</div>}
        <Markdown text={doc.content} />
      </article>
      {choosing ? (
        <div className="card">
          <strong>Ask ChatGPT about {doc.path}</strong>
          <p className="muted small">The document's text is attached to the conversation, so ChatGPT really reads it. Large documents are fitted with their outline kept.</p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => { setChoosing(false); props.onAsk(false); }} disabled={!props.connected}>
              New conversation
            </button>
            {props.currentConversationTitle && (
              <button className="btn" onClick={() => { setChoosing(false); props.onAsk(true); }} disabled={!props.connected}>
                Use “{props.currentConversationTitle.slice(0, 30)}”
              </button>
            )}
            <button className="btn btn-quiet" onClick={() => setChoosing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={() => setChoosing(true)} disabled={!props.connected} title={props.connected ? "" : "Connect ChatGPT in the Guild tab"}>
          Ask ChatGPT about this document
        </button>
      )}
      {props.error && <div className="note note-error">{props.error}</div>}
    </div>
  );
}
