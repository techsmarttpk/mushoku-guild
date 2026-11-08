import { useEffect, useMemo, useRef, useState } from "react";
import { changeSummary, syncText } from "../../domain/repo.ts";
import type { BranchInfo, GitOp, OpResult, PushPreview, RepoState } from "../../domain/types.ts";
import { api, toProviderError } from "../../ipc.ts";
import { ConfirmDialog, Menu, PromptDialog } from "./common.tsx";

export type RunGit = (op: GitOp, confirmed?: boolean) => Promise<OpResult | null>;

function BranchPopover(props: { branches: BranchInfo[]; current: string; onSwitch: (b: BranchInfo) => void; onNew: () => void; onRefresh: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [props]);
  const match = (b: BranchInfo): boolean => b.name.toLowerCase().includes(q.toLowerCase());
  const local = props.branches.filter((b) => !b.isRemote && match(b));
  const remote = props.branches.filter((b) => b.isRemote && match(b));
  const item = (b: BranchInfo) => (
    <li key={(b.isRemote ? "r:" : "l:") + b.name}>
      <button className={`branch-item ${b.current ? "cur" : ""}`} onClick={() => props.onSwitch(b)} title={b.subject}>
        <span>{b.current ? "✓ " : ""}{b.name}</span>
        <small className="muted">{b.oid} {b.track}</small>
      </button>
    </li>
  );
  return (
    <div className="branch-pop" ref={box} role="dialog" aria-label="Branches">
      <input autoFocus placeholder="Filter branches…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="branch-scroll">
        <div className="branch-head">Local</div>
        <ul>{local.map(item)}{local.length === 0 && <li className="muted small pad">none</li>}</ul>
        <div className="branch-head">Remote</div>
        <ul>{remote.map(item)}{remote.length === 0 && <li className="muted small pad">none (fetch to look for more)</li>}</ul>
      </div>
      <div className="row">
        <button className="btn btn-primary" onClick={props.onNew}>＋ New branch…</button>
        <button className="btn btn-quiet" onClick={props.onRefresh}>⟳ Refresh</button>
      </div>
    </div>
  );
}

function PushDialog(props: { projectId: number; state: RepoState; run: RunGit; onClose: () => void }) {
  const [prev, setPrev] = useState<PushPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<"branch" | "all" | "tags">("branch");
  const [remote, setRemote] = useState("");
  const [force, setForce] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  useEffect(() => {
    void api.gitPushPreview(props.projectId).then(
      (p) => {
        setPrev(p);
        setRemote(p.remote);
      },
      (e) => setErr(toProviderError(e).message),
    );
  }, [props.projectId]);
  const b = props.state.branch;
  const noUpstream = !b.upstream;
  const go = async (confirmed: boolean): Promise<void> => {
    const r = await props.run(
      { op: "push", remote: remote || null, branch: scope === "branch" ? b.head : null, set_upstream: scope === "branch" && noUpstream, all: scope === "all", tags: scope === "tags", force_with_lease: force },
      confirmed,
    );
    if (r?.ok) props.onClose();
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Push">
      <div className="dialog">
        <h3>Push</h3>
        {err && <div className="note note-error">{err}</div>}
        {!prev && !err && <div className="muted">Checking what would be pushed…</div>}
        {prev && (
          <>
            <p>
              <strong>{scope === "branch" ? b.head : scope === "all" ? "all branches" : "all tags"}</strong> → <strong>{remote || "(no remote configured)"}</strong>
              {scope === "branch" && (noUpstream ? " (a new upstream will be set)" : ` (tracking ${b.upstream})`)}
            </p>
            {prev.remotes.length === 0 && <div className="note">This repository has no remote. Add one in the Git sidebar first.</div>}
            {prev.remotes.length > 1 && (
              <label className="field">
                Remote
                <select value={remote} onChange={(e) => setRemote(e.target.value)}>
                  {prev.remotes.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="policy">
              <legend>What to push</legend>
              {(["branch", "all", "tags"] as const).map((s) => (
                <label key={s} className={`radio ${scope === s ? "on" : ""}`}>
                  <input type="radio" name="pscope" checked={scope === s} onChange={() => setScope(s)} />
                  <span>{s === "branch" ? `Current branch (${b.head})` : s === "all" ? "All branches" : "Tags"}</span>
                </label>
              ))}
            </fieldset>
            {scope === "branch" && (
              <div>
                <strong>{prev.commits.length === 0 ? (noUpstream ? "No commits to show." : "Nothing new to push.") : `${prev.commits.length}${prev.commits.length >= 30 ? "+" : ""} commit${prev.commits.length === 1 ? "" : "s"} will be pushed:`}</strong>
                <ul className="push-commits">{prev.commits.map((c, i) => <li key={i} className="mono">{c}</li>)}</ul>
              </div>
            )}
            <label className="radio">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>
                <strong>Force push (with lease)</strong>
                <small className="muted">Overwrites the remote branch only if nobody else pushed since your last fetch. Can discard other people's commits.</small>
              </span>
            </label>
          </>
        )}
        <div className="row">
          <button className="btn btn-quiet" onClick={props.onClose}>Cancel</button>
          <button className={`btn ${force ? "btn-danger" : "btn-primary"}`} disabled={!prev || prev.remotes.length === 0} onClick={() => (force ? setConfirmForce(true) : void go(false))}>
            {force ? "Force push…" : "Push"}
          </button>
        </div>
        {confirmForce && (
          <ConfirmDialog
            title="Force push?"
            danger
            confirm="Yes, force push with lease"
            message={<p>This rewrites <strong>{remote}/{scope === "branch" ? b.head : scope}</strong> on the server. If the server rejects it (protected branch) nothing changes. Continue?</p>}
            onCancel={() => setConfirmForce(false)}
            onConfirm={() => {
              setConfirmForce(false);
              void go(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

export function GitBar(props: {
  projectId: number;
  repoName: string;
  state: RepoState | null;
  branches: BranchInfo[];
  busy: string | null;
  status: { text: string; error: boolean } | null;
  run: RunGit;
  onRefresh: () => void;
  onLoadBranches: () => void;
  onShowChanges: () => void;
}) {
  const { state: st, run } = props;
  const [pop, setPop] = useState(false);
  const [newBranch, setNewBranch] = useState(false);
  const [dirtySwitch, setDirtySwitch] = useState<BranchInfo | null>(null);
  const [dirtyPull, setDirtyPull] = useState<string | null>(null);
  const [push, setPush] = useState(false);
  const [startFrom, setStartFrom] = useState("");
  const sync = useMemo(() => (st ? syncText(st) : null), [st]);
  if (!st) return <div className="gitbar muted">Reading Git state…</div>;
  if (!st.isRepo) {
    return (
      <div className="gitbar">
        <strong className="muted">This folder is not a Git repository.</strong> {st.error && <span className="muted small">{st.error}</span>}
      </div>
    );
  }
  const b = st.branch;
  const busy = props.busy !== null;
  const doSwitch = async (br: BranchInfo, stash: boolean): Promise<void> => {
    setPop(false);
    setDirtySwitch(null);
    const name = br.isRemote ? br.name.split("/").slice(1).join("/") : br.name;
    await run({ op: "switch", branch: br.isRemote ? br.name : name, remote: br.isRemote, stash });
  };
  const pull = (mode: string, autostash: boolean): void => {
    setDirtyPull(null);
    void run({ op: "pull", mode, autostash });
  };
  const tryPull = (mode: string): void => (st.clean ? pull(mode, false) : setDirtyPull(mode));

  return (
    <div className="gitbar">
      <div className="branch-wrap">
        <button className="branch-btn" onClick={() => { setPop((p) => !p); if (!pop) props.onLoadBranches(); }} title="Switch, create or manage branches" aria-haspopup="dialog" aria-expanded={pop}>
          <span className="branch-glyph" aria-hidden>⎇</span>
          <span className="branch-name">{b.detached ? `detached @ ${b.oid.slice(0, 7)}` : b.head}</span>
          {b.upstream && (
            <span className="ab" title={`${b.ahead} ahead, ${b.behind} behind ${b.upstream}`}>
              {b.ahead > 0 && <span className="ab-up">↑{b.ahead}</span>} {b.behind > 0 && <span className="ab-down">↓{b.behind}</span>}
            </span>
          )}
          <span aria-hidden>▾</span>
        </button>
        {pop && (
          <BranchPopover
            branches={props.branches}
            current={b.head}
            onClose={() => setPop(false)}
            onRefresh={props.onLoadBranches}
            onNew={() => { setPop(false); setStartFrom(""); setNewBranch(true); }}
            onSwitch={(br) => {
              if (br.current) return setPop(false);
              if (!st.clean) { setPop(false); setDirtySwitch(br); } else void doSwitch(br, false);
            }}
          />
        )}
      </div>
      <span className="commit-hash mono" title={b.oid}>{b.oid ? b.oid.slice(0, 7) : "no commits"}</span>
      <button className={`chip-btn ${st.clean ? "ok" : "dirty"}`} onClick={props.onShowChanges} title="Open the Changes list">
        {st.clean ? "● clean" : `● ${changeSummary(st)}`}
      </button>
      <span className={`sync sync-${sync?.level}`} title="Based on the last fetch; press Fetch to check the remote now">{sync?.text}</span>
      <span className="grow" />
      <Menu label={props.busy === "Fetching" || props.busy === "Fetching all remotes" ? "Fetching…" : "⟳ Fetch ▾"} items={[{ label: "Fetch", onClick: () => void run({ op: "fetch", all: false }), disabled: busy }, { label: "Fetch all remotes", onClick: () => void run({ op: "fetch", all: true }), disabled: busy }]} />
      <Menu label="⇣ Pull ▾" items={[{ label: "Pull (fast-forward only)", onClick: () => tryPull("ff-only"), disabled: busy }, { label: "Pull with rebase", onClick: () => tryPull("rebase"), disabled: busy }, { label: "Pull with merge commit", onClick: () => tryPull("merge"), disabled: busy }]} />
      <button className="btn" onClick={() => setPush(true)} disabled={busy} title="Review and push">⇡ Push…</button>
      <button className="btn btn-quiet" onClick={props.onRefresh} title="Re-read the repository state now">⟳</button>
      {props.busy && (
        <span className="busy-note">
          {props.busy}… <button className="link" onClick={() => void api.gitCancel()}>cancel</button>
        </span>
      )}
      {st.operation && (
        <div className="op-banner" role="status">
          <strong>{st.operation === "merge" ? "Merge" : st.operation === "rebase" ? "Rebase" : st.operation} in progress</strong>
          <span>{st.conflicted > 0 ? `${st.conflicted} file(s) have conflicts. Resolve them in the Changes list.` : "No conflicts left. You can complete it."}</span>
          <button className="btn btn-primary" disabled={busy || st.conflicted > 0} onClick={() => void run({ op: st.operation === "rebase" ? "rebase_continue" : "merge_continue" })}>Continue</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run({ op: st.operation === "rebase" ? "rebase_abort" : "merge_abort" })}>Abort</button>
        </div>
      )}
      {props.status && <div className={`gitstatus ${props.status.error ? "err" : ""}`} role="status">{props.status.text}</div>}

      {newBranch && (
        <PromptDialog
          title="New branch"
          label="Branch name"
          placeholder="feature/my-change"
          confirm="Create and switch"
          extra={
            <label className="field">
              Start from (optional: a branch, tag or commit; default is the current commit)
              <select value={startFrom} onChange={(e) => setStartFrom(e.target.value)}>
                <option value="">Current commit ({b.head})</option>
                {props.branches.map((x) => (
                  <option key={(x.isRemote ? "r" : "l") + x.name} value={x.name}>{x.name}</option>
                ))}
              </select>
            </label>
          }
          onCancel={() => setNewBranch(false)}
          onSubmit={(name) => {
            setNewBranch(false);
            void run({ op: "create_branch", name, start: startFrom || null, switch: true });
          }}
        />
      )}
      {dirtySwitch && (
        <ConfirmDialog
          title={`Switch to ${dirtySwitch.name}?`}
          confirm="Switch (keep changes)"
          message={<p>You have uncommitted changes ({changeSummary(st)}). Git carries them to the other branch when it can and refuses when they would be overwritten; nothing is thrown away. You can also stash them first and bring them back later.</p>}
          secondary={{ label: "Stash and switch", onClick: () => void doSwitch(dirtySwitch, true) }}
          onCancel={() => setDirtySwitch(null)}
          onConfirm={() => void doSwitch(dirtySwitch, false)}
        />
      )}
      {dirtyPull && (
        <ConfirmDialog
          title="Pull with uncommitted changes?"
          confirm="Pull anyway"
          message={<p>You have uncommitted changes ({changeSummary(st)}). If the incoming commits touch the same files, Git stops and tells you; your changes are never discarded. "Pull with autostash" saves them first and re-applies them afterwards (this can create conflicts).</p>}
          secondary={{ label: "Pull with autostash", onClick: () => pull(dirtyPull, true) }}
          onCancel={() => setDirtyPull(null)}
          onConfirm={() => pull(dirtyPull, false)}
        />
      )}
      {push && <PushDialog projectId={props.projectId} state={st} run={run} onClose={() => setPush(false)} />}
    </div>
  );
}
