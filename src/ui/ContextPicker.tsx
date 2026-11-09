import { useEffect, useState } from "react";
import { api } from "../ipc.ts";
import { DEFAULT_BUDGETS, MODES, modesFor, sizeLabel, thirdPartyWarning, type Budgets, type ContextMode, type ContextSurface } from "../domain/context.ts";
import type { Project } from "../domain/types.ts";

/**
 * "Context: [No Context ▾]" — the owner chooses, per request, how much of a repository a model may see. The size shown is the
 * local estimate of exactly what would be sent. Deep Research says plainly that it starts Claude Code.
 */
export function ContextPicker(props: {
  surface: ContextSurface;
  value: ContextMode;
  onChange: (m: ContextMode) => void;
  /** the project the context would come from */
  projectId: number | null;
  /** the text the request is about (relevant-context search uses it) */
  query: string;
  disabled?: boolean;
  /** only Universal Chat asks which project to share */
  projects?: Project[];
  onProject?: (id: number | null) => void;
  /** the provider receiving the text, for the third-party warning */
  provider?: string;
}) {
  const { surface, value, projectId } = props;
  const [tokens, setTokens] = useState<number | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (value === "none" || projectId === null) {
      setTokens(value === "none" ? 0 : null);
      setSources([]);
      return;
    }
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      api
        .contextPreview(projectId, value, props.query)
        .then(
          (p) => {
            if (!live) return;
            setTokens(p.tokens);
            setSources(p.sources);
          },
          () => live && setTokens(null),
        )
        .finally(() => live && setBusy(false));
    }, 450);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value, projectId, props.query]);

  const needsProject = value !== "none" && projectId === null;
  const warn = thirdPartyWarning(props.provider ?? "", value);
  return (
    <div className={`ctx ${value === "deep" ? "ctx-deep" : ""}`}>
      <label className="ctx-row">
        <span className="ctx-label">Context:</span>
        <select value={value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as ContextMode)} aria-label="Context mode">
          {modesFor(surface).map((m) => (
            <option key={m} value={m}>
              {MODES[m].label}
              {MODES[m].invokesClaude ? " (starts Claude Code)" : ""}
            </option>
          ))}
        </select>
        {props.projects && value !== "none" && (
          <select value={projectId ?? ""} disabled={props.disabled} onChange={(e) => props.onProject?.(e.target.value === "" ? null : Number(e.target.value))} aria-label="Project to share">
            <option value="">Choose a project…</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <small className="muted ctx-size" title={sources.length ? `From: ${sources.join(", ")}` : undefined}>
          {needsProject ? "choose a project first" : sizeLabel(value, tokens, busy)}
        </small>
      </label>
      <small className="muted ctx-hint">{MODES[value].hint}</small>
      {value === "deep" && (
        <div className="note ctx-note" role="status">
          Deep Research starts Claude Code on this repository (read-only) before ChatGPT answers. It can take several minutes. Nothing is changed.
        </div>
      )}
      {warn && (
        <div className="note ctx-note" role="status">
          {warn}
        </div>
      )}
    </div>
  );
}

/** The two target sizes, in one compact row (Guild tab). */
export function ContextBudgetsCard() {
  const [b, setB] = useState<Budgets>(DEFAULT_BUDGETS);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api.contextPrefs().then(
      (p) => setB({ capsule: p.capsuleBudget, relevant: p.relevantBudget }),
      () => undefined,
    );
  }, []);
  const save = (): void => {
    void api.contextBudgetsSet(b.capsule, b.relevant).then((p) => {
      setB({ capsule: p.capsuleBudget, relevant: p.relevantBudget });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }, () => undefined);
  };
  return (
    <section className="card">
      <h3>Context size</h3>
      <p className="muted">Target sizes (in tokens, approximate) for what Project Capsule and Relevant Context may add to a request. Deep Research is bounded by the research itself.</p>
      <div className="row ctx-budgets">
        <label className="field">
          Project Capsule
          <input type="number" min={200} max={3000} step={100} value={b.capsule} onChange={(e) => setB({ ...b, capsule: Number(e.target.value) })} />
        </label>
        <label className="field">
          Relevant excerpts
          <input type="number" min={500} max={12000} step={500} value={b.relevant} onChange={(e) => setB({ ...b, relevant: Number(e.target.value) })} />
        </label>
        <button className="btn" onClick={save}>
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </section>
  );
}
