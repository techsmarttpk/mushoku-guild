import { useEffect, useMemo, useState } from "react";
import { GRAPH, graphWidth, laneColor, laneX, rowSegments } from "../../domain/repo.ts";
import type { BranchInfo, CommitDetail, ConflictView, FileEntry, Graph, GraphRow, Remote, RepoState, StashInfo, TagInfo } from "../../domain/types.ts";
import { api, toProviderError } from "../../ipc.ts";
import type { RunGit } from "./GitBar.tsx";
import { ConfirmDialog, Menu, PromptDialog } from "./common.tsx";

const LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", conflicted: "!", untracked: "U" };
const when = (sec: number): string => new Date(sec * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// ---------------------------------------------------------------- diff

export function DiffView({ text, title, onClose }: { text: string; title: string; onClose: () => void }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <div className="diff">
      <div className="diff-head">
        <strong>{title}</strong>
        <button className="btn btn-quiet" onClick={onClose}>Close diff</button>
      </div>
      <pre className="diff-body">
        {text.trim() === "" ? <span className="muted">No textual changes (binary file, mode change or nothing to show).</span> : lines.map((l, i) => (
          <span key={i} className={l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "d-meta" : l.startsWith("@@") ? "d-hunk" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : ""}>
            {l + "\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- conflicts

export function ConflictDialog(props: { projectId: number; path: string; onClose: () => void; onOpenInEditor: (p: string) => void; run: RunGit }) {
  const [v, setV] = useState<ConflictView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api.gitConflict(props.projectId, props.path).then(setV, (e) => setErr(toProviderError(e).message));
  }, [props.projectId, props.path]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Conflict">
      <div className="dialog wide">
        <h3>Conflict in {props.path}</h3>
        <p className="muted small">Nothing was chosen for you. Open the file in the editor, resolve the conflict markers yourself, save, then mark it resolved.</p>
        {err && <div className="note note-error">{err}</div>}
        {v && (
          <div className="conflict-cols">
            {([["Your version (current branch)", v.ours], ["Their version (incoming)", v.theirs], ["Common ancestor", v.base]] as const).map(([t, text]) => (
              <div key={t}>
                <div className="conflict-title">{t}</div>
                <pre className="code conflict-pane">{text || "(empty or not present)"}</pre>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <button className="btn btn-quiet" onClick={props.onClose}>Close</button>
          <button className="btn" onClick={() => { props.onOpenInEditor(props.path); props.onClose(); }}>Open in editor</button>
          <button className="btn btn-primary" onClick={async () => { const r = await props.run({ op: "resolve", path: props.path }); if (r?.ok) props.onClose(); }}>Mark as resolved</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- changes

function FileRow(props: { e: FileEntry; staged: boolean; onOpenDiff: () => void; onToggle: () => void; onDiscard?: () => void; onOpen: () => void }) {
  const e = props.e;
  const letter = props.staged ? e.index : e.kind === "untracked" ? "U" : e.worktree;
  return (
    <li className="change-row">
      <button className="change-name" onClick={props.onOpenDiff} title={`${e.path}${e.orig ? ` (was ${e.orig})` : ""} — click for the diff`}>
        <span className={`gl gl-${e.kind}`}>{letter === "." ? LETTER[e.kind] : letter}</span> {e.path}
      </button>
      <button className="ib" title="Open in editor" onClick={props.onOpen}>✎</button>
      {props.onDiscard && <button className="ib" title="Discard changes…" onClick={props.onDiscard}>↶</button>}
      <button className="ib" title={props.staged ? "Unstage" : "Stage"} onClick={props.onToggle}>{props.staged ? "−" : "＋"}</button>
    </li>
  );
}

export function ChangesPanel(props: {
  projectId: number;
  state: RepoState;
  busy: boolean;
  run: RunGit;
  onOpenDiff: (e: FileEntry, staged: boolean) => void;
  onOpenFile: (rel: string) => void;
}) {
  const { state: st, run } = props;
  const [msg, setMsg] = useState("");
  const [discard, setDiscard] = useState<FileEntry | "all" | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [stashDlg, setStashDlg] = useState(false);
  const staged = st.entries.filter((e) => e.kind !== "untracked" && e.kind !== "conflicted" && e.index !== ".");
  const unstaged = st.entries.filter((e) => e.kind !== "untracked" && e.kind !== "conflicted" && e.worktree !== ".");
  const untracked = st.entries.filter((e) => e.kind === "untracked");
  const conflicted = st.entries.filter((e) => e.kind === "conflicted");
  const commit = async (): Promise<void> => {
    const r = await run({ op: "commit", message: msg });
    if (r?.ok) setMsg("");
  };
  const discardTargets = (d: FileEntry | "all") => {
    const list = d === "all" ? [...unstaged, ...untracked] : [d];
    return { tracked: list.filter((e) => e.kind !== "untracked").map((e) => e.path), untracked: list.filter((e) => e.kind === "untracked").map((e) => e.path) };
  };
  return (
    <div className="changes">
      {conflicted.length > 0 && (
        <section>
          <h4>Conflicts ({conflicted.length})</h4>
          <ul>
            {conflicted.map((e) => (
              <li key={e.path} className="change-row">
                <button className="change-name" onClick={() => setConflict(e.path)}><span className="gl gl-conflicted">!</span> {e.path}</button>
                <button className="ib" title="Open in editor" onClick={() => props.onOpenFile(e.path)}>✎</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <div className="sec-head">
          <h4>Staged ({staged.length})</h4>
          <button className="link" disabled={props.busy || staged.length === 0} onClick={() => void run({ op: "unstage", paths: [], all: true })}>unstage all</button>
        </div>
        <ul>{staged.map((e) => <FileRow key={"s" + e.path} e={e} staged onOpenDiff={() => props.onOpenDiff(e, true)} onToggle={() => void run({ op: "unstage", paths: [e.path], all: false })} onOpen={() => props.onOpenFile(e.path)} />)}</ul>
      </section>
      <section>
        <div className="sec-head">
          <h4>Changes ({unstaged.length + untracked.length})</h4>
          <span>
            <button className="link" disabled={props.busy || unstaged.length + untracked.length === 0} onClick={() => void run({ op: "stage", paths: [], all: true })}>stage all</button>{" "}
            <button className="link" disabled={props.busy || unstaged.length + untracked.length === 0} onClick={() => setDiscard("all")}>discard all…</button>
          </span>
        </div>
        <ul>
          {unstaged.map((e) => <FileRow key={"u" + e.path} e={e} staged={false} onOpenDiff={() => props.onOpenDiff(e, false)} onToggle={() => void run({ op: "stage", paths: [e.path], all: false })} onDiscard={() => setDiscard(e)} onOpen={() => props.onOpenFile(e.path)} />)}
          {untracked.map((e) => <FileRow key={"n" + e.path} e={e} staged={false} onOpenDiff={() => props.onOpenFile(e.path)} onToggle={() => void run({ op: "stage", paths: [e.path], all: false })} onDiscard={() => setDiscard(e)} onOpen={() => props.onOpenFile(e.path)} />)}
        </ul>
        {st.entries.length === 0 && <div className="muted small pad">Nothing to commit. Working tree clean.</div>}
      </section>
      <section className="commit-box">
        <textarea rows={3} placeholder={staged.length ? `Commit message (${staged.length} staged file${staged.length === 1 ? "" : "s"} will be committed)` : "Stage files first, then write a message"} value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && msg.trim() && staged.length) { e.preventDefault(); void commit(); } }} />
        <div className="row">
          <button className="btn btn-primary" disabled={props.busy || staged.length === 0 || !msg.trim()} onClick={() => void commit()} title="Ctrl+Enter">Commit {staged.length ? `(${staged.length})` : ""}</button>
          <button className="btn btn-quiet" disabled={props.busy || st.clean} onClick={() => setStashDlg(true)}>Stash…</button>
        </div>
        <p className="muted small">Only the staged files are committed. Nothing is staged for you.</p>
      </section>

      {discard && (
        <ConfirmDialog
          title="Discard changes?"
          danger
          confirm="Discard"
          message={
            <>
              <p>{discard === "all" ? "All unstaged changes and untracked files" : discard.path} will be thrown away. This cannot be undone.</p>
              {discardTargets(discard).untracked.length > 0 && <p className="warn-line">Untracked files will be deleted from disk.</p>}
            </>
          }
          onCancel={() => setDiscard(null)}
          onConfirm={() => {
            const t = discardTargets(discard);
            setDiscard(null);
            void run({ op: "discard", tracked: t.tracked, untracked: t.untracked }, true);
          }}
        />
      )}
      {conflict && <ConflictDialog projectId={props.projectId} path={conflict} run={run} onClose={() => setConflict(null)} onOpenInEditor={props.onOpenFile} />}
      {stashDlg && (
        <PromptDialog
          title="Stash changes"
          label="Message (optional)"
          confirm="Stash"
          extra={undefined}
          onCancel={() => setStashDlg(false)}
          onSubmit={(m) => {
            setStashDlg(false);
            void run({ op: "stash_push", message: m, include_untracked: true });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- branches, tags, stashes, remotes

type Dlg =
  | { k: "rename"; b: BranchInfo }
  | { k: "delete"; b: BranchInfo }
  | { k: "newtag" }
  | { k: "deltag"; t: TagInfo }
  | { k: "addremote" }
  | { k: "renameremote"; r: Remote }
  | { k: "urlremote"; r: Remote }
  | { k: "delremote"; r: Remote }
  | { k: "dropstash"; s: StashInfo }
  | { k: "upstream"; b: BranchInfo }
  | null;

export function GitSidebar(props: { projectId: number; state: RepoState; refreshKey: number; run: RunGit; busy: boolean; branches: BranchInfo[]; onLoadBranches: () => void }) {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [err, setErr] = useState<string | null>(null);
  const { run, state: st } = props;
  useEffect(() => {
    props.onLoadBranches();
    void Promise.all([api.gitTags(props.projectId), api.gitStashes(props.projectId), api.gitRemotes(props.projectId)]).then(([t, s, r]) => {
      setTags(t);
      setStashes(s);
      setRemotes(r);
    }, (e) => setErr(toProviderError(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId, props.refreshKey]);
  const local = props.branches.filter((b) => !b.isRemote);
  const remote = props.branches.filter((b) => b.isRemote);
  const cur = st.branch.head;
  return (
    <div className="gitside">
      {err && <div className="note note-error">{err}</div>}
      <section>
        <h4>Local branches</h4>
        <ul>
          {local.map((b) => (
            <li key={b.name} className="side-row">
              <span className={b.current ? "cur" : ""}>{b.current ? "✓ " : ""}{b.name}</span>
              <small className="muted">{b.upstream ? `→ ${b.upstream} ${b.track}` : "no upstream"}</small>
              <Menu className="ib" label="⋯" align="right" items={[
                { label: "Switch to", onClick: () => void run({ op: "switch", branch: b.name, remote: false, stash: false }), disabled: b.current },
                { label: `Merge into ${cur}`, onClick: () => void run({ op: "merge", branch: b.name, mode: "ff" }), disabled: b.current },
                { label: `Merge into ${cur} (no fast-forward)`, onClick: () => void run({ op: "merge", branch: b.name, mode: "no-ff" }), disabled: b.current },
                { label: `Rebase ${cur} onto this`, onClick: () => void run({ op: "rebase", onto: b.name }), disabled: b.current },
                "sep",
                { label: "Set upstream…", onClick: () => setDlg({ k: "upstream", b }) },
                { label: "Rename…", onClick: () => setDlg({ k: "rename", b }) },
                { label: "Delete…", onClick: () => setDlg({ k: "delete", b }), danger: true, disabled: b.current },
              ]} />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Remote branches</h4>
        <ul>
          {remote.map((b) => (
            <li key={b.name} className="side-row">
              <span>{b.name}</span>
              <small className="muted">{b.oid}</small>
              <Menu className="ib" label="⋯" align="right" items={[
                { label: "Check out as local branch (track)", onClick: () => void run({ op: "switch", branch: b.name, remote: true, stash: false }) },
                { label: `Merge into ${cur}`, onClick: () => void run({ op: "merge", branch: b.name, mode: "ff" }) },
                { label: `Rebase ${cur} onto this`, onClick: () => void run({ op: "rebase", onto: b.name }) },
                "sep",
                { label: "Delete on the remote…", onClick: () => setDlg({ k: "delete", b }), danger: true },
              ]} />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <div className="sec-head"><h4>Tags ({tags.length})</h4><button className="link" onClick={() => setDlg({ k: "newtag" })}>＋ new</button></div>
        <ul>
          {tags.map((t) => (
            <li key={t.name} className="side-row">
              <span>🏷 {t.name}</span>
              <small className="muted">{t.oid} {t.annotated ? "annotated" : "lightweight"}</small>
              <Menu className="ib" label="⋯" align="right" items={[
                { label: "Push to origin", onClick: () => void run({ op: "tag_push", remote: remotes[0]?.name ?? "origin", name: t.name }), disabled: remotes.length === 0 },
                { label: "Delete…", onClick: () => setDlg({ k: "deltag", t }), danger: true },
              ]} />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Stashes ({stashes.length})</h4>
        <ul>
          {stashes.map((s) => (
            <li key={s.name} className="side-row">
              <span title={s.subject}>{s.name}: {s.subject}</span>
              <Menu className="ib" label="⋯" align="right" items={[
                { label: "Apply (keep stash)", onClick: () => void run({ op: "stash_apply", index: s.index }) },
                { label: "Pop (apply and remove)", onClick: () => void run({ op: "stash_pop", index: s.index }) },
                { label: "Drop…", onClick: () => setDlg({ k: "dropstash", s }), danger: true },
              ]} />
            </li>
          ))}
          {stashes.length === 0 && <li className="muted small">No stashes.</li>}
        </ul>
      </section>
      <section>
        <div className="sec-head"><h4>Remotes ({remotes.length})</h4><button className="link" onClick={() => setDlg({ k: "addremote" })}>＋ add</button></div>
        <ul>
          {remotes.map((r) => (
            <li key={r.name} className="side-row">
              <span>{r.name}</span>
              <small className="muted mono" title={`fetch ${r.fetch}\npush ${r.push}`}>{r.fetch}</small>
              <Menu className="ib" label="⋯" align="right" items={[
                { label: "Change URL…", onClick: () => setDlg({ k: "urlremote", r }) },
                { label: "Rename…", onClick: () => setDlg({ k: "renameremote", r }) },
                { label: "Remove…", onClick: () => setDlg({ k: "delremote", r }), danger: true },
              ]} />
            </li>
          ))}
          {remotes.length === 0 && <li className="muted small">No remotes configured.</li>}
        </ul>
      </section>

      {dlg?.k === "rename" && <PromptDialog title={`Rename ${dlg.b.name}`} label="New name" initial={dlg.b.name} confirm="Rename" onCancel={() => setDlg(null)} onSubmit={(n) => { const b = dlg.b; setDlg(null); void run({ op: "rename_branch", old: b.name, new: n }); }} />}
      {dlg?.k === "upstream" && <PromptDialog title={`Set upstream of ${dlg.b.name}`} label="Upstream (for example origin/main)" initial={dlg.b.upstream ?? `origin/${dlg.b.name}`} confirm="Set upstream" onCancel={() => setDlg(null)} onSubmit={(u) => { const b = dlg.b; setDlg(null); void run({ op: "set_upstream", branch: b.name, upstream: u }); }} />}
      {dlg?.k === "delete" && (
        <ConfirmDialog
          title={dlg.b.isRemote ? `Delete ${dlg.b.name} on the remote?` : `Delete branch ${dlg.b.name}?`}
          danger
          confirm={dlg.b.isRemote ? "Delete on the remote" : "Delete (safe)"}
          message={dlg.b.isRemote ? <p>This removes the branch from the server for everyone. The remote may refuse if the branch is protected.</p> : <p>Git refuses if the branch has commits that are not merged. You can then force the deletion; those commits would become hard to find.</p>}
          secondary={dlg.b.isRemote ? undefined : { label: "Force delete (unmerged commits lost)", onClick: () => { const b = dlg.b; setDlg(null); void run({ op: "delete_branch", name: b.name, force: true }, true); } }}
          onCancel={() => setDlg(null)}
          onConfirm={() => {
            const b = dlg.b;
            setDlg(null);
            if (b.isRemote) { const [rem, ...rest] = b.name.split("/"); void run({ op: "delete_remote_branch", remote: rem ?? "origin", branch: rest.join("/") }, true); } else void run({ op: "delete_branch", name: b.name, force: false });
          }}
        />
      )}
      {dlg?.k === "newtag" && <PromptDialog title="New tag" label="Tag name (for example v1.0.0)" confirm="Create tag" onCancel={() => setDlg(null)} onSubmit={(n) => { setDlg(null); void run({ op: "tag_create", name: n, message: n, commit: null }); }} />}
      {dlg?.k === "deltag" && <ConfirmDialog title={`Delete tag ${dlg.t.name}?`} danger confirm="Delete tag" message={<p>The tag is removed from this repository (a copy on the remote is not touched).</p>} onCancel={() => setDlg(null)} onConfirm={() => { const t = dlg.t; setDlg(null); void run({ op: "tag_delete", name: t.name }, true); }} />}
      {dlg?.k === "dropstash" && <ConfirmDialog title={`Drop ${dlg.s.name}?`} danger confirm="Drop stash" message={<p>"{dlg.s.subject}" will be deleted permanently.</p>} onCancel={() => setDlg(null)} onConfirm={() => { const s = dlg.s; setDlg(null); void run({ op: "stash_drop", index: s.index }, true); }} />}
      {dlg?.k === "addremote" && (
        <PromptDialog title="Add remote" label="Name and URL separated by a space (for example: origin https://github.com/me/repo.git)" confirm="Add" onCancel={() => setDlg(null)} onSubmit={(v) => { setDlg(null); const [name, url] = v.split(/\s+/); if (name && url) void run({ op: "remote_add", name, url }); else setErr("Enter a name and a URL."); }} />
      )}
      {dlg?.k === "renameremote" && <PromptDialog title={`Rename remote ${dlg.r.name}`} label="New name" initial={dlg.r.name} confirm="Rename" onCancel={() => setDlg(null)} onSubmit={(n) => { const r = dlg.r; setDlg(null); void run({ op: "remote_rename", old: r.name, new: n }); }} />}
      {dlg?.k === "urlremote" && <PromptDialog title={`URL of ${dlg.r.name}`} label="New URL (credentials should not be written into URLs)" initial={dlg.r.fetch} confirm="Change URL" onCancel={() => setDlg(null)} onSubmit={(u) => { const r = dlg.r; setDlg(null); void run({ op: "remote_set_url", name: r.name, url: u }); }} />}
      {dlg?.k === "delremote" && <ConfirmDialog title={`Remove remote ${dlg.r.name}?`} danger confirm="Remove remote" message={<p>Only the local configuration entry and its remote-tracking branches are removed; the server is untouched.</p>} onCancel={() => setDlg(null)} onConfirm={() => { const r = dlg.r; setDlg(null); void run({ op: "remote_remove", name: r.name }, true); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- graph

function GraphSvg({ row, maxLanes }: { row: GraphRow; maxLanes: number }) {
  const segs = rowSegments(row);
  const w = graphWidth(maxLanes);
  return (
    <svg width={w} height={GRAPH.rowH} className="graph-svg" aria-hidden>
      {segs.map((s, i) => (
        <path key={i} d={s.x1 === s.x2 ? `M${s.x1} ${s.y1} L${s.x2} ${s.y2}` : `M${s.x1} ${s.y1} C${s.x1} ${(s.y1 + s.y2) / 2} ${s.x2} ${(s.y1 + s.y2) / 2} ${s.x2} ${s.y2}`} stroke={s.color} strokeWidth="2" fill="none" />
      ))}
      <circle cx={laneX(row.lane)} cy={GRAPH.rowH / 2} r={row.isMerge ? GRAPH.radius + 1 : GRAPH.radius} fill={row.isMerge ? "#1b110b" : laneColor(row.color)} stroke={laneColor(row.color)} strokeWidth="2" />
      {row.isHead && <circle cx={laneX(row.lane)} cy={GRAPH.rowH / 2} r={GRAPH.radius + 3.5} fill="none" stroke="#f5e6c4" strokeWidth="1.5" />}
    </svg>
  );
}

export function GraphView(props: { projectId: number; refreshKey: number; onOpenDiff: (hash: string, path: string | null, title: string) => void }) {
  const [limit, setLimit] = useState(200);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.gitGraph(props.projectId, limit).then(
      (g) => live && (setGraph(g), setErr(null)),
      (e) => live && setErr(toProviderError(e).message),
    );
    return () => {
      live = false;
    };
  }, [props.projectId, props.refreshKey, limit]);
  useEffect(() => {
    if (!sel) return setDetail(null);
    let live = true;
    void api.gitCommitDetail(props.projectId, sel).then((d) => live && setDetail(d), (e) => live && setErr(toProviderError(e).message));
    return () => {
      live = false;
    };
  }, [sel, props.projectId, props.refreshKey]);
  if (err) return <div className="note note-error">{err}</div>;
  if (!graph) return <div className="muted pad">Reading history…</div>;
  if (graph.rows.length === 0) return <div className="muted pad">No commits yet.</div>;
  return (
    <div className="graph-wrap">
      <div className="graph-list" role="list" aria-label="Commit graph">
        {graph.rows.map((r) => (
          <div key={r.hash} role="listitem" className={`graph-row ${sel === r.hash ? "sel" : ""}`} onClick={() => setSel(r.hash)} style={{ height: GRAPH.rowH }}>
            <GraphSvg row={r} maxLanes={graph.maxLanes} />
            <span className="graph-msg">
              {r.refs.map((x) => (
                <span key={x.kind + x.name} className={`ref ref-${x.kind} ${x.current ? "cur" : ""}`}>{x.kind === "head" && x.current ? "● " : x.kind === "tag" ? "🏷 " : ""}{x.name}</span>
              ))}
              {r.subject}
            </span>
            <span className="graph-meta mono">{r.short}</span>
            <span className="graph-meta">{r.author}</span>
            <span className="graph-meta">{when(r.time)}</span>
          </div>
        ))}
        {graph.truncated && <button className="btn btn-quiet" onClick={() => setLimit((l) => l * 2)}>Load more history…</button>}
      </div>
      <div className="graph-detail">
        {!detail ? (
          <div className="muted pad">Select a commit to see its details, changed files and diff.</div>
        ) : (
          <>
            <h4>{detail.subject}</h4>
            <div className="mono small">{detail.hash}</div>
            <div className="small">{detail.author} &lt;{detail.email}&gt; · {when(detail.time)}</div>
            <div className="small">{detail.parents.length === 0 ? "Root commit" : `Parent${detail.parents.length > 1 ? "s (merge)" : ""}: `}{detail.parents.map((p) => (
              <button key={p} className="link mono" onClick={() => setSel(p)}>{p.slice(0, 7)}</button>
            ))}</div>
            <div className="refs">{detail.refs.map((x) => <span key={x.kind + x.name} className={`ref ref-${x.kind}`}>{x.name}</span>)}</div>
            {detail.body && <pre className="pre commit-body">{detail.body}</pre>}
            <h4>{detail.files.length} changed file{detail.files.length === 1 ? "" : "s"}{detail.parents.length > 1 ? " (against the first parent)" : ""}</h4>
            <ul>
              {detail.files.map((f) => (
                <li key={f.path}>
                  <button className="change-name" onClick={() => props.onOpenDiff(detail.hash, f.path, `${detail.short} · ${f.path}`)}>
                    <span className={`gl gl-${f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified"}`}>{f.status}</span> {f.path}
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn" onClick={() => props.onOpenDiff(detail.hash, null, `${detail.short} · all changes`)}>View the whole diff</button>
          </>
        )}
      </div>
    </div>
  );
}
