import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PROVIDER_NAME, speakerName, type UState } from "../domain/uchat.ts";
import { STATE_LABEL, canChat, memberState, type GuildMember } from "../domain/guild.ts";
import type { UMessage, UProvider, USummary } from "../domain/types.ts";
import { Markdown, researchAge } from "./ChatPanel.tsx";
import { ErrorNote } from "./panels.tsx";

const GLYPH: Record<UProvider, string> = { chatgpt: "G", claude: "C", openrouter: "O" };

function Badge({ provider, name }: { provider: UProvider; name?: string }) {
  const label = name ?? PROVIDER_NAME[provider];
  return (
    <span className={`uc-badge uc-${provider}`} title={label} aria-label={label}>
      {GLYPH[provider]}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="link uc-copy"
      title="Copy this message"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

function Bubble({ m, provider, name }: { m: UMessage; provider: UProvider; name: string }) {
  const mine = m.role === "user";
  return (
    <div className={`uc-msg ${mine ? "uc-me" : `uc-them uc-${provider}`}`}>
      {!mine && <Badge provider={provider} name={name} />}
      <div className="uc-bubble">
        <div className="uc-meta">
          <strong>{mine ? "You" : name}</strong>
          {m.status === "interrupted" && <span className="tag"> interrupted</span>}
          <small className="muted"> · {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
          <CopyButton text={m.body} />
        </div>
        {mine ? <p className="pre">{m.body}</p> : <Markdown text={m.body} />}
      </div>
    </div>
  );
}

function Rail(props: {
  convs: USummary[];
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
    <aside className="rail uc-rail" aria-label="Universal conversations">
      <button className="btn btn-primary" onClick={props.onNew} disabled={props.busy}>
        + New conversation
      </button>
      <input type="search" placeholder="Search conversations…" value={props.query} onChange={(e) => props.onQuery(e.target.value)} aria-label="Search universal conversations" />
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
                  <span className="conv-title">
                    <Badge provider={c.provider} /> {c.title}
                  </span>
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
                    <button className="link" onClick={() => { setDraft(c.title); setRenaming(c.id); }}>
                      rename
                    </button>
                    <button className="link" onClick={() => setConfirm(c.id)}>
                      delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
        {props.convs.length === 0 && <li className="muted small">{props.query ? "No match." : "No conversations yet. Say hello!"}</li>}
      </ul>
    </aside>
  );
}

export function UniversalChat(props: {
  u: UState;
  chatgptConnected: boolean;
  claudeReady: boolean;
  /** recruited OpenRouter models the owner can talk to */
  guild: GuildMember[];
  /** the context selector, rendered above the message box */
  contextNode: ReactNode;
  onProvider: (p: UProvider, model?: string) => void;
  onQuery: (q: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onNew: () => void;
  onOpen: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
  onOlder: () => void;
}) {
  const { u } = props;
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const provider = u.current?.provider ?? u.provider;
  const model = provider === "openrouter" ? (u.current?.model ?? u.model) : "";
  const names = useMemo(() => new Map(props.guild.map((g) => [g.modelId, g.name])), [props.guild]);
  const member = props.guild.find((g) => g.modelId === model);
  const speaker = speakerName(provider, model, names);
  const available = provider === "chatgpt" ? props.chatgptConnected : provider === "claude" ? props.claudeReady : !!member && canChat(member);
  const canSend = available && !u.streaming && text.trim().length > 0;
  const lastId = u.messages.at(-1)?.id;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lastId, u.stream, u.streaming, u.current?.id]);

  const send = (): void => {
    if (!canSend) return;
    props.onSend(text.trim());
    setText("");
  };
  const unavailable =
    provider === "chatgpt"
      ? "Connect ChatGPT in the Guild tab to chat with it."
      : provider === "claude"
        ? "Claude Code was not found or is not signed in. Check it in the Guild tab."
        : !model
          ? "Pick one of your recruited models above."
          : !member
            ? "This model is no longer in the Guild. Recruit it again in the Guild tab to continue this conversation."
            : `${STATE_LABEL[memberState(member)]}${member.reason ? `: ${member.reason}` : ""}`;

  return (
    <div className="chat-wrap uc-wrap">
      <Rail convs={u.convs} selectedId={u.current?.id ?? null} query={u.query} busy={u.streaming} onQuery={props.onQuery} onOpen={props.onOpen} onNew={props.onNew} onRename={props.onRename} onDelete={props.onDelete} />
      <div className="chat uc-main">
        <div className="uc-providers" role="radiogroup" aria-label="Who do you want to talk to?">
          {(["chatgpt", "claude"] as const).map((p) => (
            <button key={p} role="radio" aria-checked={provider === p} className={`uc-provider uc-${p} ${provider === p ? "on" : ""}`} onClick={() => props.onProvider(p)} disabled={u.streaming}>
              <Badge provider={p} />
              <span>
                <strong>{PROVIDER_NAME[p]}</strong>
                <small>{p === "chatgpt" ? (props.chatgptConnected ? "connected" : "not connected") : props.claudeReady ? "Claude Code ready" : "not available"}</small>
              </span>
            </button>
          ))}
          <label className={`uc-provider uc-openrouter ${provider === "openrouter" ? "on" : ""}`}>
            <Badge provider="openrouter" name={member?.name} />
            <span>
              <strong>{member ? member.name : "Guild model"}</strong>
              <select
                value={model}
                disabled={u.streaming}
                aria-label="Recruited model"
                onChange={(e) => e.target.value && props.onProvider("openrouter", e.target.value)}
              >
                <option value="">{props.guild.length ? "Choose a recruited model…" : "No models recruited yet"}</option>
                {props.guild.map((g) => (
                  <option key={g.id} value={g.modelId} disabled={!canChat(g) && g.modelId !== model}>
                    {g.name}
                    {memberState(g) !== "available" ? ` (${memberState(g)})` : ""}
                  </option>
                ))}
                {model && !member && <option value={model}>{model} (not in the Guild)</option>}
              </select>
            </span>
          </label>
        </div>
        <div className="chat-head">
          <h3 title={u.current?.title}>{u.current?.title ?? "New conversation"}</h3>
          <span className={`uc-tag uc-${provider}`}>{provider === "openrouter" ? `OpenRouter · ${speaker}` : PROVIDER_NAME[provider]}{provider !== "openrouter" && u.current?.model ? ` · ${u.current.model}` : ""}</span>
        </div>
        {provider === "claude" && <div className="uc-note">Claude Code in conversation mode: it can only talk. No files, no commands, no repository.</div>}
        {provider === "openrouter" && model && <div className="uc-note">{speaker} is a free model on OpenRouter (a third party). It can only talk, and every message goes to exactly this model ({model}).</div>}

        <div className="chat-log uc-log" aria-live="polite">
          {u.messages.length === 0 && !u.streaming && (
            <div className="muted pad">
              Talk to {speaker} about anything: startup ideas, how something works, comparing technologies, a project you have not started yet. This chat belongs to you, not to a repository, and it never sees your code. Conversations stay here after you restart.
            </div>
          )}
          {u.hasMore && (
            <button className="btn btn-quiet uc-older" onClick={props.onOlder}>
              Load earlier messages
            </button>
          )}
          {u.messages.map((m) => (
            <Bubble key={m.id} m={m} provider={u.current?.provider ?? provider} name={speaker} />
          ))}
          {u.streaming && (
            <div className={`uc-msg uc-them uc-${provider}`}>
              <Badge provider={provider} name={speaker} />
              <div className="uc-bubble">
                <div className="uc-meta">
                  <strong>{speaker}</strong> <small className="muted">{u.stream ? "is writing…" : "is thinking…"}</small>
                </div>
                {u.stream ? <Markdown text={u.stream} /> : <span className="muted">…</span>}
              </div>
            </div>
          )}
          <div ref={end} />
        </div>
        <ErrorNote error={u.error} />
        {props.contextNode}
        <div className="chat-input uc-input">
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
            placeholder={available ? `Message ${speaker}… (Enter to send, Shift+Enter for a new line)` : unavailable}
            disabled={!available}
            aria-label={`Message ${speaker}`}
          />
          {u.streaming ? (
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
