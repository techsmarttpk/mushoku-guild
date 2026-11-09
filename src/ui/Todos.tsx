import { useMemo, useState } from "react";
import { DEFAULT_VIEW, PRIORITY_LABEL, applyView, dueLabel, isOverdue, progress, todayLocal, type Priority, type Todo, type TodoFilter, type TodoSort, type TodoView } from "../domain/todos.ts";
import type { Project } from "../domain/types.ts";

export interface TodoDraft {
  id: number | null;
  title: string;
  description: string;
  priority: Priority;
  due: string;
  projectId: number | null;
}

const BLANK: TodoDraft = { id: null, title: "", description: "", priority: "medium", due: "", projectId: null };
const FILTERS: Array<[TodoFilter, string]> = [["all", "All"], ["active", "Active"], ["completed", "Completed"], ["overdue", "Overdue"]];

function Editor(props: { draft: TodoDraft; projects: Project[]; busy: boolean; onChange: (d: TodoDraft) => void; onSave: () => void; onCancel: () => void }) {
  const { draft: d } = props;
  return (
    <form
      className="todo-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave();
      }}
    >
      <input autoFocus value={d.title} maxLength={200} onChange={(e) => props.onChange({ ...d, title: e.target.value })} placeholder="What do you need to do?" aria-label="To-do title" />
      <textarea rows={2} value={d.description} onChange={(e) => props.onChange({ ...d, description: e.target.value })} placeholder="Description (optional)" aria-label="Description" />
      <div className="todo-fields">
        <label>
          Priority
          <select value={d.priority} onChange={(e) => props.onChange({ ...d, priority: e.target.value as Priority })}>
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due date
          <input type="date" value={d.due} onChange={(e) => props.onChange({ ...d, due: e.target.value })} />
        </label>
        <label>
          Repository
          <select value={d.projectId ?? ""} onChange={(e) => props.onChange({ ...d, projectId: e.target.value === "" ? null : Number(e.target.value) })}>
            <option value="">Global (none)</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                ⌂ {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={!d.title.trim() || props.busy}>
          {d.id === null ? "Add to-do" : "Save changes"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Todos(props: {
  todos: Todo[];
  projects: Project[];
  activeProjectId: number | null;
  busy: boolean;
  error: string | null;
  onSave: (d: TodoDraft) => Promise<boolean>;
  onToggle: (id: number, done: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const [view, setView] = useState<TodoView>(DEFAULT_VIEW);
  const [draft, setDraft] = useState<TodoDraft | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const today = todayLocal();
  const nameOf = (id: number): string => props.projects.find((p) => p.id === id)?.name ?? "removed repository";
  const shown = useMemo(() => applyView(props.todos, view, today, props.activeProjectId, nameOf), [props.todos, view, today, props.activeProjectId, props.projects]);
  const prog = progress(props.todos, today);

  return (
    <div className="stack todo">
      <div className="chat-head">
        <h3>To-Do</h3>
        <button className="btn btn-primary" onClick={() => setDraft({ ...BLANK, projectId: null })} disabled={draft !== null}>
          + New to-do
        </button>
      </div>
      <div className="todo-progress" aria-label="Progress">
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={prog.percent}>
          <span style={{ width: `${prog.percent}%` }} />
        </div>
        <small className="muted">
          {prog.done} of {prog.total} done{prog.overdue > 0 ? ` · ${prog.overdue} overdue` : ""}
        </small>
      </div>
      {draft && (
        <Editor
          draft={draft}
          projects={props.projects}
          busy={props.busy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => {
            void props.onSave(draft).then((ok) => ok && setDraft(null));
          }}
        />
      )}
      {props.error && <div className="note note-error">{props.error}</div>}
      <div className="todo-controls">
        <div className="center-switch" role="group" aria-label="Filter">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={`seg ${view.filter === f ? "on" : ""}`} aria-pressed={view.filter === f} onClick={() => setView({ ...view, filter: f })}>
              {label}
            </button>
          ))}
        </div>
        <label className="todo-sort">
          Sort
          <select value={view.sort} onChange={(e) => setView({ ...view, sort: e.target.value as TodoSort })}>
            <option value="due">Due date</option>
            <option value="priority">Priority</option>
            <option value="created">Newest</option>
          </select>
        </label>
      </div>
      <input type="search" value={view.query} onChange={(e) => setView({ ...view, query: e.target.value })} placeholder="Search to-dos…" aria-label="Search to-dos" />
      <label className="radio">
        <input type="checkbox" checked={view.repoOnly} disabled={props.activeProjectId === null} onChange={(e) => setView({ ...view, repoOnly: e.target.checked })} />
        <span>Only the active repository{props.activeProjectId !== null ? ` (${nameOf(props.activeProjectId)})` : ""}. Global to-dos are shown otherwise.</span>
      </label>
      <ul className="list todo-list">
        {shown.map((t) => (
          <li key={t.id} className={`todo-item p-${t.priority} ${t.done ? "done" : ""} ${isOverdue(t, today) ? "late" : ""}`}>
            <input type="checkbox" checked={t.done} onChange={(e) => props.onToggle(t.id, e.target.checked)} aria-label={t.done ? `Mark “${t.title}” not done` : `Mark “${t.title}” done`} />
            <div className="todo-body">
              <span className="todo-title">{t.title}</span>
              {t.description && <small className="muted todo-desc">{t.description}</small>}
              <span className="todo-meta">
                <span className={`pill pr-${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
                {t.due && <small className={isOverdue(t, today) ? "ext-flag" : "muted"}>{dueLabel(t, today)}</small>}
                {t.projectId !== null && (
                  <span className="repo-tag" title="Repository">
                    <span aria-hidden>⌂</span> {nameOf(t.projectId)}
                  </span>
                )}
              </span>
            </div>
            {confirm === t.id ? (
              <div className="conv-confirm">
                <span>Delete?</span>
                <button className="link" onClick={() => { props.onDelete(t.id); setConfirm(null); }}>
                  yes
                </button>
                <button className="link" onClick={() => setConfirm(null)}>
                  no
                </button>
              </div>
            ) : (
              <div className="conv-actions">
                <button className="link" onClick={() => setDraft({ id: t.id, title: t.title, description: t.description, priority: t.priority, due: t.due ?? "", projectId: t.projectId })}>
                  edit
                </button>
                <button className="link" onClick={() => setConfirm(t.id)}>
                  delete
                </button>
              </div>
            )}
          </li>
        ))}
        {shown.length === 0 && <li className="muted">{props.todos.length === 0 ? "Nothing to do yet. Add your first to-do." : "No to-do matches this view."}</li>}
      </ul>
      <small className="muted">To-dos are personal notes: they never start a quest or call an AI.</small>
    </div>
  );
}
