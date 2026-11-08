// Smaller building blocks shared by several tabs: repository tag, per-repository permission profile,
// browser integration card and the launched-services list.
import { useState } from "react";
import type { BrowserStatus, Policy, PrefsView, Project, ServiceView } from "../domain/types.ts";

export function RepoTag({ project }: { project: Project | null }) {
  return (
    <span className="repo-tag" title={project?.path ?? "No repository selected"}>
      <span aria-hidden>⌂</span> {project ? project.name : "no repository"}
    </span>
  );
}

export const POLICY_NAME: Record<Policy, string> = {
  ask_each: "Ask me for every action",
  read_only: "Read-only",
  accept_edits: "Allow edits, ask for commands",
};

/** The saved permission profile of the current repository, with trust and revoke controls. */
export function PermissionsCard(props: {
  project: Project | null;
  prefs: PrefsView | null;
  /** policy and mode currently selected in the form (defaults come from the saved profile) */
  policy: Policy;
  autopilot: boolean;
  onPolicy: (p: Policy) => void;
  onAutopilot: (on: boolean) => void;
  onTrust: () => void;
  onRevoke: () => void;
  onRelink: () => void;
  busy: boolean;
}) {
  const { prefs, project } = props;
  const [open, setOpen] = useState(false);
  if (!project || !prefs) return null;
  const trusted = prefs.trust === "trusted";
  const fields = (
    <>
      <fieldset className="policy">
        <legend>What may Claude do in {project.name}?</legend>
        {(Object.keys(POLICY_NAME) as Policy[]).map((p) => (
          <label key={p} className={`radio ${props.policy === p ? "on" : ""}`}>
            <input type="radio" name="repo-policy" checked={props.policy === p} onChange={() => props.onPolicy(p)} />
            <span>
              <strong>{POLICY_NAME[p]}</strong>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="radio">
        <input type="checkbox" checked={props.autopilot} onChange={(e) => props.onAutopilot(e.target.checked)} />
        <span>
          <strong>Start quests in Auto Pilot by default</strong>
          <small className="muted">Routine Bash commands run without asking; risky ones, browser actions and anything outside the repository still ask.</small>
        </span>
      </label>
    </>
  );
  if (prefs.trust === "trusted" && !open) {
    return (
      <div className="perm-card ok">
        <div className="row">
          <strong>● Trusted repository</strong>
          <span className="muted small">
            saved: {POLICY_NAME[prefs.policy]} · {prefs.autopilot ? "Auto Pilot by default" : "ask every time"}
          </span>
          <button className="link" onClick={() => setOpen(true)}>
            edit
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={`perm-card ${trusted ? "ok" : "warn"}`}>
      <strong>
        {prefs.trust === "untrusted" ? "▲ Trust this repository" : prefs.trust === "reconfirm" ? "▲ Please confirm this repository again" : "● Trusted repository"}
      </strong>
      {prefs.trust === "untrusted" && <p className="muted">First time here. Choose what Claude may do in this repository and confirm that you trust it. This is saved for this repository only; the safety limits (secrets, system changes, destructive commands, outside the folder) always stay.</p>}
      {prefs.trust === "reconfirm" && (
        <p className="muted">
          {prefs.folderExists ? "Its location or Git identity changed since you trusted it." : "The repository folder was not found."} Nothing is allowed until you confirm again.
        </p>
      )}
      {fields}
      <div className="row">
        <button className="btn btn-primary" onClick={() => { props.onTrust(); setOpen(false); }} disabled={props.busy || !prefs.folderExists}>
          {trusted ? "Save permissions" : "I trust this repository"}
        </button>
        {!prefs.folderExists && (
          <button className="btn" onClick={props.onRelink}>
            Find the folder…
          </button>
        )}
        {(trusted || prefs.trust === "reconfirm") && (
          <button className="btn btn-quiet" onClick={props.onRevoke}>
            Reset and revoke trust
          </button>
        )}
      </div>
    </div>
  );
}

export function BrowserCard(props: {
  status: BrowserStatus | null;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onInstall: () => void;
  onOpenChrome: () => void;
  onRecheck: () => void;
}) {
  const s = props.status;
  return (
    <section className="card">
      <h3>
        Browser <span className="tag">Claude in Chrome</span>
      </h3>
      <p className="muted">
        Lets Claude Code use your Chrome through Anthropic's official extension (`claude --chrome`): open pages, read them, click and type, check console errors, test your local app. Browser actions always ask you, and the extension keeps its own site permissions. If a login or CAPTCHA appears, Claude pauses for you.
      </p>
      <label className="radio">
        <input type="checkbox" checked={!!s?.enabled} onChange={(e) => props.onToggle(e.target.checked)} disabled={props.busy} />
        <span>
          <strong>Use my browser in quests</strong>
        </span>
      </label>
      {s === null ? (
        <div className="muted">Checking…</div>
      ) : (
        <>
          <div className={s.state === "ready" ? "ok-line" : s.state === "disabled" ? "muted" : "warn-line"}>
            {s.state === "ready" ? "● Ready" : s.state === "disabled" ? "○ Off" : "▲ " + s.state.replace(/_/g, " ")}
          </div>
          <div className="muted small">{s.message}</div>
          <div className="muted small">
            Extension: {s.extensionInstalled ? "found" : "not found"} · Chrome: {s.chromeRunning ? "running" : "not running"} · Claude Code `--chrome`: {s.cliSupported ? "supported" : "not available"}
          </div>
          {s.enabled && !s.nativeHostRegistered && s.extensionInstalled && <div className="muted small">The connection is set up the first time a quest starts with the browser; if Chrome does not notice it, restart Chrome once.</div>}
          <div className="row">
            {s.enabled && !s.extensionInstalled && (
              <button className="btn btn-primary" onClick={props.onInstall}>
                Install extension (opens the official page)
              </button>
            )}
            {s.enabled && s.extensionInstalled && !s.chromeRunning && (
              <button className="btn" onClick={props.onOpenChrome}>
                Open Chrome
              </button>
            )}
            <button className="btn btn-quiet" onClick={props.onRecheck}>
              Check again
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Websites and applications launched by a quest: separate from the quest's own status. */
export function ServicesPanel(props: {
  services: ServiceView[];
  onOpen: (id: number, chrome: boolean) => void;
  onStop: (id: number) => void;
  onFocus: (id: number) => void;
  chromeAvailable: boolean;
}) {
  if (props.services.length === 0) return null;
  return (
    <section className="card services">
      <h4>Launched by this quest</h4>
      <p className="muted small">These keep running on their own after the quest finishes. Stopping them is up to you (they also stop when Mushoku Guild closes).</p>
      {props.services.map((s) => (
        <div key={s.id} className="service">
          <div className="service-main">
            <span className={s.live ? "ok-line" : "muted"}>{s.live ? "●" : "○"}</span> <strong>{s.kind === "url" ? s.url : s.label}</strong>
            <div className="muted small">{s.kind === "url" ? (s.live ? "responding" : "not responding right now") : s.live ? "process running" : "process ended"}</div>
          </div>
          <div className="row">
            {s.kind === "url" && (
              <>
                <button className="btn btn-primary" onClick={() => props.onOpen(s.id, false)}>
                  Open in browser
                </button>
                {props.chromeAvailable && (
                  <button className="btn" onClick={() => props.onOpen(s.id, true)}>
                    Open in Chrome
                  </button>
                )}
              </>
            )}
            {s.kind === "process" && s.live && (
              <>
                <button className="btn" onClick={() => props.onFocus(s.id)}>
                  Focus
                </button>
                <button className="btn btn-danger" onClick={() => props.onStop(s.id)}>
                  Stop
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
