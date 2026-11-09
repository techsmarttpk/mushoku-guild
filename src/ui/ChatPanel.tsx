import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { highlight } from "../domain/highlight.ts";
import { isMermaid, parseMarkdown, type Block, type Inline } from "../domain/markdown.ts";
import { MermaidBoundary } from "./Mermaid.tsx";
import type { UiState } from "../domain/store.ts";
import type { ChatMessage, ConvSummary, Project, ResearchView } from "../domain/types.ts";
import { RepoTag } from "./Extras.tsx";
import { ErrorNote } from "./panels.tsx";

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((x, i) =>
        x.t === "code" ? (
          <code key={i}>{x.s}</code>
        ) : x.t === "b" ? (
          <strong key={i}>{x.s}</strong>
        ) : x.t === "i" ? (
          <em key={i}>{x.s}</em>
        ) : (
          <Fragment key={i}>{x.s}</Fragment>
        ),
      )}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.k) {
    case "h":
      return <div className={`md-h md-h${Math.min(b.level, 3)}`}><Inlines items={b.inline} /></div>;
    case "p":
      return <p><Inlines items={b.inline} /></p>;
    case "code":
      if (isMermaid(b.lang)) return <MermaidBoundary source={b.text} />;
      return (
        <pre className="code md-code" data-lang={b.lang || undefined}>
          {highlight(b.text, b.lang).map((t, i) => (t.t === "txt" ? <Fragment key={i}>{t.s}</Fragment> : <span key={i} className={`tok-${t.t}`}>{t.s}</span>))}
        </pre>
      );
    case "table":
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>{b.head.map((h, i) => <th key={i}><Inlines items={h} /></th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}><Inlines items={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "ul":
      return <ul>{b.items.map((it, i) => <li key={i}><Inlines items={it} /></li>)}</ul>;
    case "ol":
      return <ol>{b.items.map((it, i) => <li key={i}><Inlines items={it} /></li>)}</ol>;
    case "quote":
      return <blockquote><Inlines items={b.inline} /></blockquote>;
    case "hr":
      return <hr />;
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<ResearchView["status"], string> = {
  none: "No repository context",
  researching: "Research in progress…",
  ready: "Context available",
  stale: "Context needs refreshing",
  failed: "Research failed",
  cancelled: "Research cancelled",
};

export function researchAge(at: number | null, now = Date.now()): string {
  if (!at) return "";
  const min = Math.max(0, Math.round((now - at) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : new Date(at).toLocaleDateString();
}

function Rail(props: {
  convs: ConvSummary[];
  selectedId: number | null;
  query: string;
  busy: boolean;
  onQuery: (q: string) => void;
  onOpen: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
}) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<number | null>(null);
  return (
    <aside className="rail" aria-label="Conversations">
      <button className="btn btn-primary" onClick={props.onNew} disabled={props.busy}>
        + New conversation
      </button>
      <input type="search" placeholder="Search conversations…" value={props.query} onChange={(e) => props.onQuery(e.target.value)} aria-label="Search conversations" />
      <ul className="list rail-list">
        {props.convs.map((c) => (
          <li key={c.id}>
            {renaming === c.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) props.onRename(c.id, draft.trim());
                  setRenaming(null);
                }}
              >
                <input autoFocus value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} onBlur={() => setRenaming(null)} aria-label="Conversation title" />
              </form>
            ) : (
              <div className={`conv ${c.id === props.selectedId ? "on" : ""}`}>
                <button className="conv-main" onClick={() => props.onOpen(c.id)} aria-current={c.id === props.selectedId}>
                  <span className="conv-title">{c.title}</span>
                  <small className="muted">
                    {c.messageCount} msg · {researchAge(c.updatedAt)}
                  </small>
                  {c.snippet && <small className="muted conv-snip">…{c.snippet}</small>}
                </button>
                {confirm === c.id ? (
                  <div className="conv-confirm">
                    <span>Delete?</span>
                    <button className="link" onClick={() => { props.onDelete(c.id); setConfirm(null); }}>
                      yes
                    </button>
                    <button className="link" onClick={() => setConfirm(null)}>
                      no
                    </button>
                  </div>
                ) : (
                  <div className="conv-actions">
                    <button className="link" title="Rename" onClick={() => { setDraft(c.title); setRenaming(c.id); }}>
                      rename
                    </button>
                    <button className="link" title="Delete" onClick={() => setConfirm(c.id)}>
                      delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
        {props.convs.length === 0 && <li className="muted small">{props.query ? "No match." : "No conversations yet."}</li>}
      </ul>
    </aside>
  );
}

function MessageView({ m }: { m: ChatMessage }) {
  if (m.kind === "doc") {
    const path = /File: (.+)/.exec(m.body)?.[1] ?? "document";
    return <div className="msg msg-doc">📖 Attached document <code>{path}</code> (its text is part of this conversation)</div>;
  }
  const who = m.role === "user" ? "You" : m.role === "agent" ? "Claude · repository research" : "ChatGPT";
  return (
    <div className={`msg msg-${m.role}`}>
      <div className="msg-who">
        {who}
        {m.status === "interrupted" && <span className="tag"> interrupted</span>}
        <small className="muted"> · {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
      </div>
      {m.role === "user" ? <p className="pre">{m.body}</p> : <Markdown text={m.body} />}
    </div>
  );
}

export function ChatPanel(props: {
  state: UiState;
  project: Project | null;
  connected: boolean;
  claudeReady: boolean;
  query: string;
  onQuery: (q: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onNew: () => void;
  onOpenConv: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
  onResearch: () => void;
  onCancelResearch: () => void;
  /** the context selector, rendered above the message box */
  contextNode?: ReactNode;
}) {
  const { state, project } = props;
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const research = state.research;
  const researching = research?.status === "researching";
  const busyTurn = state.chatStreaming || state.chatResearching !== null;
  const canSend = props.connected && !!state.conversation && !busyTurn && text.trim().length > 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [state.chatMessages.length, state.chatStream, state.chatResearching]);

  if (!project) {
    return (
      <div className="stack">
        <div className="note">Connect a project folder in the Guild tab to start a project-specific conversation. Every repository keeps its own conversations.</div>
      </div>
    );
  }
  const send = (): void => {
    if (!canSend) return;
    props.onSend(text.trim());
    setText("");
  };
  const lastActivity = state.researchActivity.at(-1);

  return (
    <div className="chat-wrap">
      <Rail convs={state.convs} selectedId={state.conversation?.id ?? null} query={props.query} busy={busyTurn} onQuery={props.onQuery} onOpen={props.onOpenConv} onNew={props.onNew} onRename={props.onRename} onDelete={props.onDelete} />
      <div className="chat">
        <div className="chat-head">
          <h3 title={state.conversation?.title}>{state.conversation?.title ?? "Chat"}</h3>
          <RepoTag project={project} />
        </div>
        <div className="ctx-bar">
          <span className={`ctx-pill r-${research?.status ?? "none"}`}>● {STATUS_TEXT[research?.status ?? "none"]}</span>
          {research?.researchedAt && <span className="muted small">researched {researchAge(research.researchedAt)}</span>}
          {researching ? (
            <button className="btn btn-quiet" onClick={props.onCancelResearch}>
              Stop research
            </button>
          ) : (
            <button className="btn" onClick={props.onResearch} disabled={!props.claudeReady || busyTurn} title="Optional: have Claude Code read the whole repository and write a full report. ChatGPT also asks Claude on its own when a question needs it.">
              {research && research.status !== "none" ? "Refresh research" : "Ask Claude for Context"}
            </button>
          )}
        </div>
        {research?.note && research.status !== "ready" && <div className="note">{research.note}</div>}
        {research && research.report && (
          <details className="research-box">
            <summary>Repository report ({research.files.length} files inspected)</summary>
            <Markdown text={research.report} />
            {research.files.length > 0 && <p className="muted small">Files read: {research.files.slice(0, 60).join(", ")}</p>}
          </details>
        )}

        <div className="chat-log" aria-live="polite">
          {state.chatMessages.length === 0 && !busyTurn && (
            <div className="muted pad">
              Talk to ChatGPT about {project.name}: architecture, what to build next, why something works the way it does. ChatGPT decides by itself when it needs evidence and then asks Claude to read the relevant code (read-only), so you do not have to. Simple questions are answered directly.
            </div>
          )}
          {state.chatMessages.map((m) => (
            <MessageView key={m.id} m={m} />
          ))}
          {state.chatResearching !== null && (
            <div className="msg msg-agent msg-live">
              <div className="msg-who">Claude · researching…</div>
              <p className="pre">{state.chatResearching}</p>
              {lastActivity && <p className="muted small">{lastActivity.title}: {lastActivity.detail.slice(0, 100)}</p>}
              <p className="muted small">Read-only: Claude can read and search files and look at Git history. It cannot change anything.</p>
            </div>
          )}
          {state.chatStreaming && state.chatResearching === null && (
            <div className="msg msg-assistant">
              <div className="msg-who">ChatGPT {state.chatStream ? "is writing…" : "is thinking…"}</div>
              {state.chatStream ? <Markdown text={state.chatStream} /> : <span className="muted">…</span>}
            </div>
          )}
          <div ref={end} />
        </div>
        <ErrorNote error={state.chatError} />
        {props.contextNode}
        <div className="chat-input">
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={props.connected ? "Message ChatGPT… (Enter to send, Shift+Enter for a new line)" : "Connect ChatGPT in the Guild tab to chat"}
            disabled={!props.connected}
          />
          {busyTurn ? (
            <button className="btn btn-quiet" onClick={props.onStop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={send} disabled={!canSend}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
