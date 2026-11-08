// Labels and small rules for the quest history, shared by the UI and its tests.
import type { QuestRow, TaskStatus } from "./types.ts";

export type QuestBadge = "draft" | "awaiting" | "running" | "completed" | "failed" | "cancelled";

/** Six user-facing states over the nine stored statuses. */
export function questBadge(status: TaskStatus): QuestBadge {
  switch (status) {
    case "draft":
    case "reasoning":
      return "draft";
    case "prompt_ready":
    case "approved":
      return "awaiting";
    case "running":
      return "running";
    case "completed":
    case "accepted":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export const BADGE_LABEL: Record<QuestBadge, string> = {
  draft: "Draft",
  awaiting: "Awaiting approval",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const questStatusText = (s: TaskStatus): string => (s === "approved" ? "Approved, ready to run" : s === "accepted" ? "Completed (accepted)" : BADGE_LABEL[questBadge(s)]);

export const MODEL_NAME: Record<string, string> = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku", default: "CLI default", "": "-" };
export const modelName = (m: string): string => MODEL_NAME[m] ?? m;

/** Filters history by a free-text query over title and summary (case-insensitive). */
export function filterQuests(rows: QuestRow[], query: string): QuestRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((r) => r.title.toLowerCase().includes(q) || r.summary.toLowerCase().includes(q)) : rows;
}

export const summaryOf = (r: QuestRow): string => (r.summary.trim() ? r.summary.trim().replace(/\s+/g, " ").slice(0, 140) : "No result yet");
