import { useState } from "react";
import { BADGE_LABEL, filterQuests, modelName, questBadge, summaryOf } from "../domain/quests.ts";
import type { Project, QuestRow } from "../domain/types.ts";
import { RepoTag } from "./Extras.tsx";

export function QuestHistory(props: { project: Project | null; quests: QuestRow[]; selectedId: number | null; onOpen: (id: number) => void; onNew: () => void }) {
  const [query, setQuery] = useState("");
  if (!props.project) return <div className="note">Connect a project folder in the Guild tab first. Quests belong to a repository.</div>;
  const rows = filterQuests(props.quests, query);
  return (
    <div className="stack">
      <div className="chat-head">
        <h3>Quests</h3>
        <RepoTag project={props.project} />
      </div>
      <button className="btn btn-primary btn-wide" onClick={props.onNew}>
        ＋ New Quest
      </button>
      {props.quests.length > 3 && <input type="search" placeholder="Search quests…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search quests" />}
      <ul className="list">
        {rows.map((q) => {
          const badge = questBadge(q.status);
          return (
            <li key={q.id}>
              <button className={`list-item quest ${q.id === props.selectedId ? "on" : ""}`} onClick={() => props.onOpen(q.id)}>
                <span className="quest-top">
                  <span className="quest-title">{q.title}</span>
                  <span className={`pill b-${badge}`}>{BADGE_LABEL[badge]}</span>
                </span>
                <small className="muted">
                  {new Date(q.createdAt).toLocaleString()} · {q.model ? modelName(q.model) : "-"} · {q.permissionMode === "autopilot" ? "Auto Pilot" : q.permissionMode === "ask" ? "asks every time" : "not run yet"}
                </small>
                <small className="quest-summary">{summaryOf(q)}</small>
              </button>
            </li>
          );
        })}
        {rows.length === 0 && <li className="muted">{props.quests.length === 0 ? `No quests in ${props.project.name} yet. Press New Quest to start one.` : "No match."}</li>}
      </ul>
    </div>
  );
}
