// To-Do view logic (pure). Storage is in Rust/SQLite; the whole list is small, so filtering and sorting happen here.
export type Priority = "low" | "medium" | "high";

export interface Todo {
  id: number;
  title: string;
  description: string;
  priority: Priority;
  /** local calendar date YYYY-MM-DD */
  due: string | null;
  done: boolean;
  doneAt: number | null;
  /** optional repository tag; null = global */
  projectId: number | null;
  createdAt: number;
  updatedAt: number;
}

export type TodoFilter = "all" | "active" | "completed" | "overdue";
export type TodoSort = "due" | "priority" | "created";

export interface TodoView {
  filter: TodoFilter;
  query: string;
  sort: TodoSort;
  /** only to-dos tagged with the active repository (global ones are hidden by this filter alone) */
  repoOnly: boolean;
}

export const DEFAULT_VIEW: TodoView = { filter: "active", query: "", sort: "due", repoOnly: false };
export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High" };
const RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

const pad = (n: number): string => String(n).padStart(2, "0");
/** Today's date on the computer's calendar (not UTC). */
export function todayLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isOverdue(t: Todo, today: string): boolean {
  return !t.done && t.due !== null && t.due < today;
}

export function dueLabel(t: Todo, today: string): string {
  if (!t.due) return "";
  if (t.due === today) return "due today";
  return isOverdue(t, today) ? `overdue since ${t.due}` : `due ${t.due}`;
}

function compare(sort: TodoSort): (a: Todo, b: Todo) => number {
  const byDue = (a: Todo, b: Todo): number => (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1);
  const byPriority = (a: Todo, b: Todo): number => RANK[a.priority] - RANK[b.priority];
  const byCreated = (a: Todo, b: Todo): number => b.createdAt - a.createdAt || b.id - a.id;
  return (a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1; // completed items sink but stay visible
    if (sort === "priority") return byPriority(a, b) || byDue(a, b) || byCreated(a, b);
    if (sort === "created") return byCreated(a, b);
    return byDue(a, b) || byPriority(a, b) || byCreated(a, b);
  };
}

export function applyView(todos: Todo[], view: TodoView, today: string, activeProjectId: number | null, projectName: (id: number) => string = () => ""): Todo[] {
  const terms = view.query.toLowerCase().split(/\s+/).filter(Boolean);
  return todos
    .filter((t) => {
      if (view.filter === "active" && t.done) return false;
      if (view.filter === "completed" && !t.done) return false;
      if (view.filter === "overdue" && !isOverdue(t, today)) return false;
      if (view.repoOnly && (activeProjectId === null || t.projectId !== activeProjectId)) return false;
      if (terms.length === 0) return true;
      const hay = `${t.title}\n${t.description}\n${t.projectId !== null ? projectName(t.projectId) : ""}`.toLowerCase();
      return terms.every((x) => hay.includes(x));
    })
    .sort(compare(view.sort));
}

export interface Progress {
  done: number;
  total: number;
  percent: number;
  overdue: number;
}

export function progress(todos: Todo[], today: string): Progress {
  const done = todos.filter((t) => t.done).length;
  return { done, total: todos.length, percent: todos.length ? Math.round((done / todos.length) * 100) : 0, overdue: todos.filter((t) => isOverdue(t, today)).length };
}
