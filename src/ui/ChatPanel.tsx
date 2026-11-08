import { Fragment, useEffect, useRef, useState } from "react";
import { parseMarkdown, type Block, type Inline } from "../domain/markdown.ts";
import type { UiState } from "../domain/store.ts";
import type { ResearchView } from "../domain/types.ts";
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
      return <pre className="code md-code" data-lang={b.lang || undefined}>{b.text}</pre>;
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

export function ChatPanel(props: {
  state: UiState;
  projectName: string | null;
  connected: boolean;
  claudeReady: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onNew: () => void;
  onResearch: () => void;
  onCancelResearch: () => void;
}) {
  const { state } = props;
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const research = state.research;
  const researching = research?.status === "researching";
  const canSend = props.connected && !!state.conversation && !state.chatStreaming && text.trim().length > 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [state.chatMessages.length, state.chatStream]);

  if (!props.projectName) return <div className="note">Choose a project folder in the Guild tab first.</div>;
  const send = (): void => {
    if (!canSend) return;
    props.onSend(text.trim());
    setText("");
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <h3>Chat · {props.projectName}</h3>
        <button className="btn btn-quiet" onClick={props.onNew} disabled={state.chatStreaming}>
          New conversation
        </button>
      </div>
      <div className="ctx-bar">
        <span className={`ctx-pill r-${research?.status ?? "none"}`}>● {STATUS_TEXT[research?.status ?? "none"]}</span>
        {research?.researchedAt && <span className="muted small">researched {researchAge(research.researchedAt)}</span>}
        {researching ? (
          <button className="btn btn-quiet" onClick={props.onCancelResearch}>
            Stop research
          </button>
        ) : (
          <button className="btn btn-primary" onClick={props.onResearch} disabled={!props.claudeReady || state.chatStreaming} title="Claude Code reads the repository (read-only) and reports back to ChatGPT">
            {research && research.status !== "none" ? "Refresh research" : "Ask Claude for Context"}
          </button>
        )}
      </div>
      {research?.note && research.status !== "ready" && <div className="note">{research.note}</div>}
      {!props.claudeReady && <div className="muted small">Claude Code is not ready (Guild tab), so research is unavailable.</div>}
      {research && research.report && (
        <details className="research-box">
          <summary>
            Repository research ({research.files.length} files inspected)
          </summary>
          <Markdown text={research.report} />
          {research.files.length > 0 && <p className="muted small">Files read: {research.files.slice(0, 60).join(", ")}</p>}
        </details>
      )}

      <div className="chat-log" aria-live="polite">
        {state.chatMessages.length === 0 && !state.chatStreaming && (
          <div className="muted pad">
            Ask anything about {props.projectName}: its architecture, what to build next, why something works the way it does. ChatGPT only knows the project profile
            and Claude's research, never your files directly. For a real opinion, press <strong>Ask Claude for Context</strong> first.
          </div>
        )}
        {state.chatMessages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <div className="msg-who">{m.role === "user" ? "You" : "ChatGPT"}</div>
            {m.role === "user" ? <p className="pre">{m.body}</p> : <Markdown text={m.body} />}
          </div>
        ))}
        {state.chatStreaming && (
          <div className="msg msg-assistant">
            <div className="msg-who">ChatGPT {state.chatStream ? "is writing…" : "is thinking…"}</div>
            {state.chatStream ? <Markdown text={state.chatStream} /> : <span className="muted">…</span>}
          </div>
        )}
        <div ref={end} />
      </div>
      <ErrorNote error={state.chatError} />
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
        {state.chatStreaming ? (
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
  );
}
