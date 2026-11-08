import { useEffect, useRef, useState } from "react";
import { MODEL_LABEL, modelChoice, type ClaudeModelChoice } from "../domain/types.ts";
import type {
  Activity,
  ContextInfo,
  ChatGptStatus,
  ClaudeInfo,
  Model,
  Policy,
  Project,
  ProviderError,
  Task,
  TaskDetail,
} from "../domain/types.ts";
import type { PermissionRequest, UiState } from "../domain/store.ts";

// ---------------------------------------------------------------- small shared pieces

export function ErrorNote({ error, onDismiss }: { error: ProviderError | null; onDismiss?: () => void }) {
  if (!error) return null;
  const hint: Partial<Record<ProviderError["kind"], string>> = {
    not_connected: "Open the Guild tab and connect first.",
    auth_expired: "Your sign-in is no longer valid. Connect again in the Guild tab.",
    eligibility: "This account may not be eligible for ChatGPT plan usage (OpenAI documents Plus and Pro; other plans are unconfirmed).",
    usage_limit: "A usage limit was reached. Try again after the limit resets.",
    network: "Check your internet connection and try again.",
  };
  return (
    <div className="note note-error" role="alert">
      <strong>{error.message}</strong>
      {hint[error.kind] && <div className="muted">{hint[error.kind]}</div>}
      {onDismiss && (
        <button className="link" onClick={onDismiss}>
          dismiss
        </button>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  reasoning: "ChatGPT is writing",
  prompt_ready: "Prompt awaiting approval",
  approved: "Approved — ready to run",
  running: "Claude Code is working",
  completed: "Completed — review the result",
  failed: "Failed",
  cancelled: "Cancelled",
  accepted: "Accepted",
};
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;

// ---------------------------------------------------------------- project context indicator

export function ContextBadge({ context, busy }: { context: ContextInfo | null; busy: boolean }) {
  const [label, cls] = busy
    ? ["Project context: scanning…", ""]
    : context === null
      ? ["Project context: not collected", ""]
      : context.status === "ready"
        ? ["Project context: ready", "ok-line"]
        : context.status === "stale"
          ? ["Project context: needs refresh", "warn-line"]
          : ["Project context: unavailable (ChatGPT will use only your description)", "warn-line"];
  return <span className={`ctx-badge ${cls}`}>● {label}</span>;
}

function ContextCard(props: { context: ContextInfo | null; busy: boolean; onRefresh: () => void }) {
  const c = props.context;
  return (
    <div className="stack">
      <div className="row">
        <ContextBadge context={c} busy={props.busy} />
        <button className="btn btn-quiet" onClick={props.onRefresh} disabled={props.busy}>
          Refresh context
        </button>
      </div>
      {c?.error && <div className="note">{c.error}</div>}
      {c && c.text && (
        <details>
          <summary>Inspect what ChatGPT will receive ({c.text.length.toLocaleString()} characters{c.truncated ? ", shortened" : ""})</summary>
          <p className="muted small">Collected locally from: {c.sources.join(", ") || "nothing"}. Secrets, .env files, keys, build output and dependencies are excluded; secret-looking values are redacted. ChatGPT sees only this text, never your files.</p>
          <pre className="code">{c.text}</pre>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Guild (setup)

export function GuildPanel(props: {
  state: UiState;
  models: Model[];
  busy: string | null;
  onConnect: () => void;
  onCancelConnect: () => void;
  onDisconnect: () => void;
  onLoadModels: () => void;
  onSetting: (key: string, value: string) => void;
  onRecheckClaude: () => void;
  onPickClaude: () => void;
  onPickProject: () => void;
  onSelectProject: (p: Project) => void;
  onRefreshContext: () => void;
  authError: ProviderError | null;
}) {
  const { state } = props;
  return (
    <div className="stack">
      <ChatGptCard {...props} />
      <ClaudeCard
        info={state.claude}
        model={state.settings["claude_model"] ?? ""}
        maxTurns={state.settings["max_turns"] ?? "40"}
        busy={props.busy === "claude"}
        onSetting={props.onSetting}
        onRecheck={props.onRecheckClaude}
        onPick={props.onPickClaude}
        rate={state.rate}
      />
      <section className="card">
        <h3>Project</h3>
        <p className="muted">Claude Code runs inside the folder you choose. Use a copy or a test folder if you are experimenting.</p>
        <div className="row">
          <button className="btn" onClick={props.onPickProject}>
            Choose folder…
          </button>
        </div>
        {state.currentProjectId !== null && <ContextCard context={state.context} busy={state.contextBusy} onRefresh={props.onRefreshContext} />}
        <ul className="list">
          {state.projects.map((p) => (
            <li key={p.id}>
              <button className={`list-item ${p.id === state.currentProjectId ? "on" : ""}`} onClick={() => props.onSelectProject(p)}>
                <span>{p.name}</span>
                <small className="muted">{p.path}</small>
              </button>
            </li>
          ))}
          {state.projects.length === 0 && <li className="muted">No project yet.</li>}
        </ul>
      </section>
    </div>
  );
}

function ChatGptCard(props: {
  state: UiState;
  models: Model[];
  busy: string | null;
  onConnect: () => void;
  onCancelConnect: () => void;
  onDisconnect: () => void;
  onLoadModels: () => void;
  onSetting: (key: string, value: string) => void;
  authError: ProviderError | null;
}) {
  const s = props.state;
  const status: ChatGptStatus = s.chatgpt;
  const waiting = s.authStage !== "idle";
  const chosen = s.settings["chatgpt_model"] ?? "";
  return (
    <section className="card">
      <h3>
        ChatGPT <span className="tag">Reasoner · experimental</span>
      </h3>
      <p className="muted">
        Signs in with the official “Sign in with ChatGPT” flow in your browser. Your password is never seen by this app; the refresh token is stored in
        Windows Credential Manager. OpenAI documents this for Plus and Pro plans; other plans (including Go) are unconfirmed and may be refused.
      </p>
      {status.connected ? (
        <>
          <div className="ok-line">● Connected{status.label ? ` as ${status.label}` : ""}</div>
          <div className="row">
            <button className="btn" onClick={props.onLoadModels} disabled={props.busy === "models"}>
              {props.models.length ? "Reload models" : "Load models"}
            </button>
            <button className="btn btn-quiet" onClick={props.onDisconnect}>
              Disconnect
            </button>
          </div>
          {props.models.length > 0 && (
            <label className="field">
              Model (discovered at runtime)
              <select value={chosen} onChange={(e) => props.onSetting("chatgpt_model", e.target.value)}>
                <option value="">Automatic (first available)</option>
                {props.models.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.displayName} ({m.slug})
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted small">Disconnecting removes the stored token here. To remove the app grant on OpenAI’s side, use ChatGPT Settings → connected apps.</p>
        </>
      ) : waiting ? (
        <>
          <div className="warn-line">{s.authStage === "waiting_browser" ? "Waiting for you to finish signing in in your browser…" : "Finishing sign-in…"}</div>
          {s.authUrl && <p className="muted small">If no browser window opened, copy this link into a browser: <span className="mono">{s.authUrl.slice(0, 80)}…</span></p>}
          <button className="btn btn-quiet" onClick={props.onCancelConnect}>
            Cancel sign-in
          </button>
        </>
      ) : (
        <>
          <div className="row">
            <button className="btn btn-primary" onClick={props.onConnect}>
              Connect ChatGPT
            </button>
          </div>
        </>
      )}
      <ErrorNote error={props.authError} />
    </section>
  );
}

function ClaudeCard(props: {
  info: ClaudeInfo | null;
  model: string;
  maxTurns: string;
  busy: boolean;
  rate: UiState["rate"];
  onSetting: (k: string, v: string) => void;
  onRecheck: () => void;
  onPick: () => void;
}) {
  const i = props.info;
  const pct = (v: number | null | undefined) => (v == null ? "?" : `${Math.round(v * 100)}%`);
  return (
    <section className="card">
      <h3>
        Claude Code <span className="tag">Executor</span>
      </h3>
      <p className="muted">
        Uses your own installed Claude Code CLI and its existing login. Mushoku Guild never reads Claude credentials. Anthropic’s policy on third-party use of
        subscriptions is unresolved, so this build is for personal, local use only.
      </p>
      {i === null ? (
        <div className="muted">Checking…</div>
      ) : (
        <>
          {i.path ? (
            <div className={i.error ? "warn-line" : "ok-line"}>
              {i.error ? "▲" : "●"} {i.version ?? "version unknown"}
            </div>
          ) : (
            <div className="warn-line">▲ Not found</div>
          )}
          {i.path && <div className="muted small mono">{i.path}</div>}
          {i.path && (
            <div className="muted small">
              Signature: {i.signatureValid ? `valid (${i.signer ?? "signed"})` : "not verified"} · Login: {i.loggedIn === null ? "unknown" : i.loggedIn ? `signed in (${i.authMethod ?? "?"})` : "signed out"}
            </div>
          )}
          {i.error && <div className="note note-error">{i.error}</div>}
          {i.warnings.map((w) => (
            <div key={w} className="note">
              {w}
            </div>
          ))}
        </>
      )}
      {props.rate && (
        <div className="muted small">
          Claude usage window: 5 h {pct(props.rate.fiveHour)} · 7 d {pct(props.rate.sevenDay)} ({props.rate.status ?? "?"})
        </div>
      )}
      <div className="row">
        <button className="btn" onClick={props.onRecheck} disabled={props.busy}>
          Check again
        </button>
        <button className="btn btn-quiet" onClick={props.onPick}>
          Choose claude.exe…
        </button>
      </div>
      <div className="muted small">Using: <strong>{MODEL_LABEL[modelChoice(props.model)]}</strong> for every quest. If your account cannot use a model, Claude Code reports it in the result; pick another here.</div>
      <div className="row two">
        <label className="field">
          Claude model
          <select value={modelChoice(props.model)} onChange={(e) => props.onSetting("claude_model", e.target.value)}>
            {(Object.keys(MODEL_LABEL) as ClaudeModelChoice[]).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABEL[m]}
                {m === "sonnet" ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Max turns
          <input
            type="number"
            min={1}
            max={200}
            defaultValue={props.maxTurns}
            onBlur={(e) => e.target.value !== props.maxTurns && props.onSetting("max_turns", e.target.value)}
          />
        </label>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Quest (workflow)

const POLICY_TEXT: Record<Policy, { name: string; text: string }> = {
  ask_each: { name: "Ask me for every action", text: "Claude may read freely. Every edit, file write or shell command waits for your Allow." },
  read_only: { name: "Read-only", text: "Claude may only read, search and explain. Any change is blocked automatically." },
  accept_edits: { name: "Allow edits, ask for commands", text: "File edits inside the project are allowed automatically; shell commands still wait for your Allow." },
};

export function NewTask(props: { project: Project | null; context: ContextInfo | null; contextBusy: boolean; connected: boolean; onSubmit: (title: string, description: string) => void; busy: boolean }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  if (!props.project) return <div className="note">Choose a project folder in the Guild tab first.</div>;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit(title, desc);
        setTitle("");
        setDesc("");
      }}
    >
      <h3>New quest for {props.project.name}</h3>
      <ContextBadge context={props.context} busy={props.contextBusy} />
      <label className="field">
        Title (optional)
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <label className="field">
        What should be done?
        <textarea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe the change, bug or feature in your own words…" />
      </label>
      {!props.connected && <div className="note">Connect ChatGPT in the Guild tab so the Reasoner can write the Claude prompt.</div>}
      <button className="btn btn-primary" disabled={!desc.trim() || props.busy}>
        Create quest and ask ChatGPT
      </button>
    </form>
  );
}

export function TaskView(props: {
  state: UiState;
  detail: TaskDetail;
  connected: boolean;
  claudeReady: boolean;
  policy: Policy;
  onPolicy: (p: Policy) => void;
  onGenerate: (note: string | null) => void;
  onStopReasoner: () => void;
  onApprove: (body: string) => void;
  onStart: () => void;
  onCancelRun: () => void;
  onAccept: () => void;
  onRetry: () => void;
}) {
  const { detail, state } = props;
  const task = detail.task;
  const latest = detail.drafts.at(-1) ?? null;
  const [body, setBody] = useState(latest?.body ?? "");
  const [note, setNote] = useState("");
  useEffect(() => {
    setBody(latest?.body ?? "");
  }, [latest?.id]);
  const lastExec = detail.executions.at(-1) ?? null;
  const edited = latest !== null && body.trim() !== latest.body.trim();

  return (
    <div className="stack">
      <div className="task-head">
        <h3>{task.title}</h3>
        <span className={`pill s-${task.status}`}>{statusLabel(task.status)}</span>
      </div>
      <ContextBadge context={state.context} busy={state.contextBusy} />
      <details open={task.status === "draft"}>
        <summary>Your request</summary>
        <p className="pre">{task.description}</p>
      </details>
      <ErrorNote error={state.error} />

      {task.status === "draft" && (
        <button className="btn btn-primary" onClick={() => props.onGenerate(null)} disabled={!props.connected}>
          {props.connected ? "Ask ChatGPT to write the Claude prompt" : "Connect ChatGPT first (Guild tab)"}
        </button>
      )}

      {task.status === "reasoning" && (
        <>
          <label className="field">
            Prompt being written{state.streaming ? "…" : " (waiting for ChatGPT)"}
            <textarea rows={14} readOnly value={state.streamText} placeholder="The reply streams in here as ChatGPT writes it." />
          </label>
          <button className="btn btn-quiet" onClick={props.onStopReasoner}>
            Stop
          </button>
        </>
      )}

      {task.status === "prompt_ready" && latest && (
        <>
          <label className="field">
            Claude prompt — v{latest.version} {latest.source === "user" ? "(edited by you)" : `(${latest.model ?? "ChatGPT"})`}
            <textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn btn-primary" onClick={() => props.onApprove(body)} disabled={!body.trim()}>
              {edited ? "Save edit and approve" : "Approve prompt"}
            </button>
          </div>
          <label className="field">
            Ask ChatGPT to revise it
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. also add tests, or keep the change smaller" />
          </label>
          <button
            className="btn"
            disabled={!note.trim() || !props.connected}
            onClick={() => {
              props.onGenerate(note);
              setNote("");
            }}
          >
            Revise with ChatGPT
          </button>
        </>
      )}

      {task.status === "approved" && (
        <>
          <details>
            <summary>Approved prompt</summary>
            <p className="pre">{detail.drafts.filter((d) => d.approved).at(-1)?.body ?? latest?.body}</p>
          </details>
          <fieldset className="policy">
            <legend>What may Claude do?</legend>
            {(Object.keys(POLICY_TEXT) as Policy[]).map((p) => (
              <label key={p} className={`radio ${props.policy === p ? "on" : ""}`}>
                <input type="radio" name="policy" checked={props.policy === p} onChange={() => props.onPolicy(p)} />
                <span>
                  <strong>{POLICY_TEXT[p].name}</strong>
                  <small className="muted">{POLICY_TEXT[p].text}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="row">
            <button className="btn btn-primary" onClick={props.onStart} disabled={!props.claudeReady}>
              {props.claudeReady ? "Start Claude Code" : "Claude Code not ready (Guild tab)"}
            </button>
          </div>
          <label className="field">
            Or change the prompt first
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Describe what to change…" />
          </label>
          <button
            className="btn btn-quiet"
            disabled={!note.trim() || !props.connected}
            onClick={() => {
              props.onGenerate(note);
              setNote("");
            }}
          >
            Revise with ChatGPT
          </button>
        </>
      )}

      {task.status === "running" && (
        <div className="row">
          <button className="btn btn-danger" onClick={props.onCancelRun}>
            Cancel execution
          </button>
          <span className="muted small">Cancel asks Claude to stop; if it does not, the whole process tree is terminated.</span>
        </div>
      )}

      {(task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "accepted") && (
        <>
          <section className={`card result r-${task.status}`}>
            <h4>{statusLabel(task.status)}</h4>
            {lastExec?.note && <p className="pre">{lastExec.note}</p>}
            {(state.finalNote ?? lastExec?.resultText) && task.status !== "cancelled" && <p className="pre">{state.finalNote ?? lastExec?.resultText}</p>}
            {lastExec && lastExec.denialCount > 0 && (
              <p className="muted small">{lastExec.denialCount} action(s) were denied (not a failure — Claude carried on without them).</p>
            )}
            {lastExec && (
              <p className="muted small">
                Policy: {POLICY_TEXT[lastExec.policy]?.name ?? lastExec.policy}
                {lastExec.numTurns != null ? ` · ${lastExec.numTurns} turns` : ""}
              </p>
            )}
          </section>
          {task.status === "completed" && (
            <div className="row">
              <button className="btn btn-primary" onClick={props.onAccept}>
                Accept result
              </button>
            </div>
          )}
          {task.status !== "accepted" && (
            <>
              {(task.status === "failed" || task.status === "cancelled") && (
                <button className="btn" onClick={props.onRetry}>
                  Run the same prompt again
                </button>
              )}
              <label className="field">
                Request changes
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should be different? ChatGPT will revise the prompt." />
              </label>
              <button
                className="btn"
                disabled={!note.trim() || !props.connected}
                onClick={() => {
                  props.onGenerate(note);
                  setNote("");
                }}
              >
                Ask ChatGPT for a revised prompt
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- history

export function HistoryList(props: { tasks: Task[]; selectedId: number | null; onOpen: (t: Task) => void }) {
  return (
    <ul className="list">
      {props.tasks.map((t) => (
        <li key={t.id}>
          <button className={`list-item ${t.id === props.selectedId ? "on" : ""}`} onClick={() => props.onOpen(t)}>
            <span>{t.title}</span>
            <small className={`pill s-${t.status}`}>{statusLabel(t.status)}</small>
            <small className="muted">{new Date(t.updatedAt).toLocaleString()}</small>
          </button>
        </li>
      ))}
      {props.tasks.length === 0 && <li className="muted">No quests in this project yet.</li>}
    </ul>
  );
}

// ---------------------------------------------------------------- activity feed and permission prompt

const ICON: Record<string, string> = {
  init: "▶",
  assistant_text: "💬",
  tool_use: "⚙",
  tool_result: "✓",
  tool_error: "✗",
  permission_request: "❓",
  permission_decision: "🔒",
  permission_denied: "⛔",
  rate_limit: "⏳",
  result: "★",
  cancelled: "■",
  error: "✗",
  info: "ℹ",
};

export function ActivityFeed({ items, empty }: { items: Activity[]; empty: string }) {
  const end = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length]);
  if (items.length === 0) return <div className="muted pad">{empty}</div>;
  return (
    <ol className="feed" aria-live="polite">
      {items.map((a) => {
        const long = a.detail.length > 140;
        const expanded = open.has(a.seq);
        return (
          <li key={a.seq} className={`ev ev-${a.kind}`}>
            <span className="ev-icon" aria-hidden>
              {ICON[a.kind] ?? "·"}
            </span>
            <div className="ev-body">
              <div className="ev-title">{a.title}</div>
              {a.detail && (
                <div className="ev-detail pre" onClick={() => long && setOpen((o) => new Set(o.has(a.seq) ? [...o].filter((x) => x !== a.seq) : [...o, a.seq]))}>
                  {long && !expanded ? `${a.detail.slice(0, 140)}…  (click to expand)` : a.detail}
                </div>
              )}
            </div>
          </li>
        );
      })}
      <div ref={end} />
    </ol>
  );
}

export function PermissionDialog({ request, onDecide }: { request: PermissionRequest; onDecide: (allow: boolean) => void }) {
  const deny = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    deny.current?.focus();
  }, [request.requestId]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <div className="dialog">
        <h3 id="perm-title">Claude asks permission</h3>
        <p>
          Claude Code wants to use <strong>{request.toolName}</strong>:
        </p>
        <pre className="code">{request.summary}</pre>
        <details>
          <summary>Full request</summary>
          <pre className="code">{request.input}</pre>
        </details>
        <div className="row">
          <button ref={deny} className="btn btn-danger" onClick={() => onDecide(false)}>
            Deny
          </button>
          <button className="btn btn-primary" onClick={() => onDecide(true)}>
            Allow once
          </button>
        </div>
        <p className="muted small">Denying is safe: Claude continues without this action. The run waits here until you decide (10 minutes, then it is denied).</p>
      </div>
    </div>
  );
}
