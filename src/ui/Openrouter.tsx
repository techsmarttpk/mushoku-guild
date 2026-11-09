import { useCallback, useEffect, useRef, useState } from "react";
import { api, toProviderError } from "../ipc.ts";
import {
  CATALOG_REFRESH_MS,
  STATE_LABEL,
  canChat,
  capabilityLabels,
  formatContext,
  memberState,
  pickSeed,
  seedSignature,
  type GuildMember,
  type OrModel,
  type OrStatus,
  type OrTest,
} from "../domain/guild.ts";
import type { ProviderError } from "../domain/types.ts";
import { researchAge } from "./ChatPanel.tsx";

// Errors from OpenRouter are shown as they are; the shared ErrorNote adds ChatGPT-specific hints that would mislead here.
function OrError({ error }: { error: ProviderError | null }) {
  if (!error) return null;
  return (
    <div className="note note-error" role="alert">
      <strong>{error.message}</strong>
    </div>
  );
}

function Chips({ labels }: { labels: string[] }) {
  return (
    <div className="chips">
      {labels.map((l) => (
        <span key={l} className="chip ok">
          {l}
        </span>
      ))}
    </div>
  );
}

function ConnectForm({ onConnected }: { onConnected: (s: OrStatus) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProviderError | null>(null);
  const submit = (): void => {
    const k = key;
    setKey(""); // the key leaves the form (and React state) the moment it is submitted
    setBusy(true);
    setError(null);
    void api
      .orConnect(k)
      .then(onConnected, (e: unknown) => setError(toProviderError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) submit();
      }}
    >
      <label className="field">
        OpenRouter API key
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key (it is stored in Windows Credential Manager)" disabled={busy} />
      </label>
      <div className="row">
        <button className="btn btn-primary" disabled={!key.trim() || busy}>
          {busy ? "Checking…" : "Connect OpenRouter"}
        </button>
        <small className="muted">The key is sent once to the app's Rust core, checked with OpenRouter and kept in Credential Manager. This window never stores it.</small>
      </div>
      <OrError error={error} />
    </form>
  );
}

function TestBox({ modelId, disabled }: { modelId: string; disabled?: boolean }) {
  const [prompt, setPrompt] = useState("Say hello in one short sentence.");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<OrTest | null>(null);
  const [error, setError] = useState<ProviderError | null>(null);
  const run = (): void => {
    setBusy(true);
    setRes(null);
    setError(null);
    void api
      .orTestModel(modelId, prompt)
      .then(setRes, (e: unknown) => setError(toProviderError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="or-test">
      <div className="row">
        <input value={prompt} maxLength={500} onChange={(e) => setPrompt(e.target.value)} aria-label="Test prompt" disabled={busy} />
        <button className="btn" onClick={run} disabled={busy || disabled || !prompt.trim()}>
          {busy ? "Testing…" : "Test model"}
        </button>
      </div>
      <small className="muted">Free models only. A test sends just this prompt.</small>
      {res && (
        <div className="or-test-out">
          <p className="pre">{res.text || "(empty reply)"}</p>
          <small className="muted">
            {(res.latencyMs / 1000).toFixed(1)} s
            {res.usage?.totalTokens != null && ` · ${res.usage.totalTokens} tokens`}
            {res.usage?.cost != null && ` · cost ${res.usage.cost}`}
          </small>
        </div>
      )}
      <OrError error={error} />
    </div>
  );
}

interface Detail {
  id: string;
  name: string;
  vendor: string;
  contextLength: number | null;
  description: string;
  inputModalities: string[];
  outputModalities: string[];
  caps: OrModel["caps"];
}

function ModelDetails({ m }: { m: Detail }) {
  return (
    <div className="or-detail">
      <div className="muted small">
        Provider: <strong>{m.vendor}</strong> · Model ID: <code>{m.id}</code>
      </div>
      <div className="muted small">
        Context length: {formatContext(m.contextLength)} · Input: {m.inputModalities.join(", ") || "unknown"} · Output: {m.outputModalities.join(", ") || "unknown"}
      </div>
      <Chips labels={capabilityLabels(m.caps)} />
      {m.description && <p className="small or-desc">{m.description}</p>}
      <small className="muted">Free eligibility: verified from OpenRouter's pricing data (every price is zero).</small>
    </div>
  );
}

// ---------------------------------------------------------------- recruitment dialog

const PAGE = 30;

function Recruit(props: { status: OrStatus; guild: GuildMember[]; onStatus: (s: OrStatus) => void; onGuild: (g: GuildMember[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<OrModel[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<OrModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProviderError | null>(null);
  const recruited = new Set(props.guild.map((g) => g.modelId));
  const connected = props.status.connected;

  const load = useCallback((q: string, offset: number) => {
    void api.orCatalog(q, offset, PAGE).then(
      (p) => {
        setTotal(p.total);
        setItems((old) => (offset === 0 ? p.models : [...old, ...p.models]));
      },
      (e: unknown) => setError(toProviderError(e)),
    );
  }, []);
  useEffect(() => {
    const t = setTimeout(() => load(query, 0), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, load, props.status.catalogAt]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const recruit = (m: OrModel): void => {
    setBusy(true);
    setError(null);
    const taken = new Set(props.guild.map((g) => seedSignature(g.seed)));
    void api
      .guildRecruit(m.id, pickSeed(m.id, taken))
      .then(
        (g) => {
          props.onGuild(g);
          props.onClose();
        },
        (e: unknown) => setError(toProviderError(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog wide or-dialog" role="dialog" aria-modal="true" aria-label="Recruit a free model">
        <div className="row between">
          <h3>Recruit a free model</h3>
          <button className="btn btn-quiet" onClick={props.onClose} aria-label="Close">
            Close
          </button>
        </div>
        {!connected ? (
          <>
            <p className="muted">Connect your OpenRouter account to browse free models.</p>
            <ConnectForm onConnected={props.onStatus} />
          </>
        ) : (
          <>
            <p className="muted small">
              Only models OpenRouter lists as free (a <code>:free</code> id and a price of zero on every field) appear here. A model that stops being free is blocked, never swapped for a paid one.
            </p>
            <input type="search" autoFocus placeholder={`Search ${props.status.eligible} free models…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search free models" />
            <div className="or-browse">
              <ul className="list or-list" aria-label="Free models">
                {items.map((m) => (
                  <li key={m.id}>
                    <button className={`list-item ${selected?.id === m.id ? "on" : ""}`} onClick={() => setSelected(m)}>
                      <span>
                        {m.name} {recruited.has(m.id) && <span className="tag">in the Guild</span>}
                      </span>
                      <small className="muted">
                        {m.vendor} · {formatContext(m.contextLength)}
                      </small>
                    </button>
                  </li>
                ))}
                {items.length === 0 && <li className="muted small pad">{props.status.eligible === 0 ? "No catalogue yet. Use “Refresh models” in the OpenRouter card." : "No match."}</li>}
                {items.length < total && (
                  <li>
                    <button className="btn btn-quiet" onClick={() => load(query, items.length)}>
                      Load more ({items.length} of {total})
                    </button>
                  </li>
                )}
              </ul>
              <div className="or-pane">
                {selected ? (
                  <>
                    <h4>{selected.name}</h4>
                    <ModelDetails m={selected} />
                    <TestBox modelId={selected.id} />
                    <div className="row">
                      <button className="btn btn-primary" onClick={() => recruit(selected)} disabled={busy || recruited.has(selected.id)}>
                        {recruited.has(selected.id) ? "Already in the Guild" : busy ? "Checking it is still free…" : "Recruit into the Guild"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="muted">Select a model to see what it can do, test it, and recruit it. It becomes a character in the café.</p>
                )}
                <OrError error={error} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the Guild tab sections

function MemberRow({ m, onChat, onRemove }: { m: GuildMember; onChat: (m: GuildMember) => void; onRemove: (m: GuildMember) => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const st = memberState(m);
  return (
    <li className="or-member">
      <div className="row between">
        <div>
          <strong>{m.name}</strong>
          <div className="muted small">
            {m.vendor} · <code>{m.modelId}</code>
          </div>
        </div>
        <span className={`or-state or-${st}`} title={m.reason || STATE_LABEL[st]}>
          <i aria-hidden /> {STATE_LABEL[st]}
        </span>
      </div>
      {st === "unavailable" && <div className="note small">{m.reason} Its character and conversations are kept; new messages are blocked.</div>}
      <div className="row">
        <button className="btn" onClick={() => onChat(m)} disabled={!canChat(m)}>
          Chat
        </button>
        <button className="btn btn-quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide details" : "Details & test"}
        </button>
        {confirm ? (
          <span className="small">
            Remove from the Guild? Conversations are kept.{" "}
            <button className="link" onClick={() => onRemove(m)}>
              yes
            </button>{" "}
            <button className="link" onClick={() => setConfirm(false)}>
              no
            </button>
          </span>
        ) : (
          <button className="btn btn-quiet" onClick={() => setConfirm(true)}>
            Remove
          </button>
        )}
      </div>
      {open && (
        <>
          <ModelDetails m={{ id: m.modelId, name: m.name, vendor: m.vendor, contextLength: m.contextLength, description: m.description, inputModalities: [], outputModalities: [], caps: m.caps }} />
          <TestBox modelId={m.modelId} disabled={st !== "available"} />
        </>
      )}
    </li>
  );
}

/** OpenRouter connection, the Guild roster with its rectangular "+" button, and the recruitment dialog. */
export function GuildModels(props: { guild: GuildMember[]; onGuild: (g: GuildMember[]) => void; onChat: (m: GuildMember) => void }) {
  const { guild, onGuild } = props;
  const [status, setStatus] = useState<OrStatus | null>(null);
  const [recruiting, setRecruiting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<ProviderError | null>(null);
  const autoRefreshed = useRef(false);

  const refresh = useCallback(
    (why: string): void => {
      setBusy(why);
      setError(null);
      void api
        .orRefreshCatalog()
        .then(
          (s) => {
            setStatus(s);
            return api.guildList().then(onGuild);
          },
          (e: unknown) => setError(toProviderError(e)),
        )
        .finally(() => setBusy(null));
    },
    [onGuild],
  );

  useEffect(() => {
    void api.orStatus().then((s) => {
      setStatus(s);
      // Eligibility is re-checked when this tab opens and the catalogue is stale (and again before every request, in Rust).
      const stale = s.catalogAt === null || Date.now() - s.catalogAt > CATALOG_REFRESH_MS;
      if (!autoRefreshed.current && stale && (s.connected || guild.length > 0)) {
        autoRefreshed.current = true;
        refresh("auto");
      }
    }, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connected = status?.connected ?? false;
  return (
    <>
      <section className="card">
        <h3>OpenRouter (free models)</h3>
        <p className="muted">
          Recruit free models from OpenRouter as characters in the café and chat with them in Universal Chat. Only models that are verifiably free are offered; there is never a fallback to a paid model.
        </p>
        {!status ? (
          <p className="muted">Loading…</p>
        ) : !connected ? (
          <ConnectForm onConnected={(s) => { setStatus(s); refresh("connect"); }} />
        ) : (
          <div className="stack">
            <div className="row">
              <span className="or-state or-available">
                <i aria-hidden /> Connected
              </span>
              <small className="muted">
                {status.eligible} free models available (of {status.total} listed){status.catalogAt ? ` · checked ${researchAge(status.catalogAt)}` : ""}
              </small>
            </div>
            <div className="row">
              <button className="btn" onClick={() => refresh("refresh")} disabled={busy !== null}>
                {busy === "refresh" || busy === "auto" || busy === "connect" ? "Refreshing…" : "Refresh models"}
              </button>
              <button
                className="btn btn-quiet"
                disabled={busy !== null}
                onClick={() => {
                  setBusy("test");
                  setError(null);
                  setInfo(null);
                  void api
                    .orTestConnection()
                    .then((k) => setInfo(`Key accepted${k.freeTier ? " (free tier)" : ""}.`), (e: unknown) => setError(toProviderError(e)))
                    .finally(() => setBusy(null));
                }}
              >
                Test connection
              </button>
              <button
                className="btn btn-quiet"
                disabled={busy !== null}
                onClick={() => {
                  void api.orDisconnect().then((s) => {
                    setStatus(s);
                    setInfo("Disconnected. The key was removed from Credential Manager. Your recruited characters and conversations are kept.");
                    void api.guildList().then(onGuild);
                  });
                }}
              >
                Disconnect
              </button>
            </div>
            {info && <div className="note small">{info}</div>}
          </div>
        )}
        <OrError error={error} />
      </section>

      <section className="card">
        <div className="row between">
          <h3>Guild members</h3>
          <button className="btn-plus" onClick={() => setRecruiting(true)} aria-label="Recruit a model" title="Recruit a free model">
            +
          </button>
        </div>
        {guild.length === 0 ? (
          <p className="muted">No models recruited yet. Press + to browse free models. Each recruit appears as a character in the café.</p>
        ) : (
          <ul className="list or-roster">
            {guild.map((m) => (
              <MemberRow
                key={m.id}
                m={m}
                onChat={props.onChat}
                onRemove={(x) => void api.guildRemove(x.id).then(onGuild, (e: unknown) => setError(toProviderError(e)))}
              />
            ))}
          </ul>
        )}
      </section>

      {recruiting && status && <Recruit status={status} guild={guild} onStatus={(s) => { setStatus(s); refresh("connect"); }} onGuild={onGuild} onClose={() => setRecruiting(false)} />}
    </>
  );
}
