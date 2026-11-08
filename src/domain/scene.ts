// Pure projection from REAL application state to what the café shows. There is no scripted sequence:
// every pose below is selected by a field the Rust core reported (task status, a streaming reply,
// a pending permission request, the tool Claude is currently running, how the last execution ended).
import type { TaskStatus } from "./types.ts";

export interface SceneInput {
  status: TaskStatus | null;
  /** ChatGPT text deltas are arriving right now. */
  streaming: boolean;
  /** A permission request is waiting for the user. */
  permissionPending: boolean;
  /** Tool Claude has started and not yet finished (null between tools). */
  currentTool: string | null;
  /** Claude is researching the repository (read-only). */
  researching?: boolean;
  /** ChatGPT is answering in Guild Chat. */
  chatting?: boolean;
}

export type ReasonerPose = "idle" | "thinking" | "writing" | "present" | "cheer";
export type ExecutorPose =
  | "idle"
  | "ready"
  | "thinking"
  | "typing"
  | "writing"
  | "reading"
  | "attention"
  | "celebrate"
  | "error";
export type Spot = "lounge" | "desk" | "board";
export type BoardState = "empty" | "drafting" | "pending" | "approved" | "active" | "done" | "failed" | "cancelled";
export type BubbleKind = "none" | "dots" | "pencil" | "alert" | "check" | "cross" | "gear";

export interface SceneState {
  reasoner: { pose: ReasonerPose; spot: Spot; bubble: BubbleKind };
  executor: { pose: ExecutorPose; spot: Spot; bubble: BubbleKind };
  board: BoardState;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

export function executorPoseForTool(tool: string | null): ExecutorPose {
  if (tool === null) return "thinking";
  if (WRITE_TOOLS.has(tool)) return "writing";
  if (READ_TOOLS.has(tool)) return "reading";
  return "typing"; // Bash and anything else that executes
}

export const IDLE_SCENE: SceneState = {
  reasoner: { pose: "idle", spot: "lounge", bubble: "none" },
  executor: { pose: "idle", spot: "lounge", bubble: "none" },
  board: "empty",
};

export function projectScene(i: SceneInput): SceneState {
  switch (i.status) {
    case null:
      if (i.researching) return { ...IDLE_SCENE, executor: { pose: "reading", spot: "desk", bubble: "gear" }, board: "empty" };
      if (i.chatting) return { ...IDLE_SCENE, reasoner: { pose: "thinking", spot: "lounge", bubble: "dots" } };
      return IDLE_SCENE;
    case "accepted":
      return { ...IDLE_SCENE, reasoner: { pose: "cheer", spot: "lounge", bubble: "check" }, board: "done" };
    case "draft":
      return { ...IDLE_SCENE, board: "drafting" };
    case "reasoning":
      return {
        ...IDLE_SCENE,
        reasoner: {
          pose: i.streaming ? "writing" : "thinking",
          spot: "desk",
          bubble: i.streaming ? "pencil" : "dots",
        },
        board: "drafting",
      };
    case "prompt_ready":
      return { ...IDLE_SCENE, reasoner: { pose: "present", spot: "board", bubble: "none" }, board: "pending" };
    case "approved":
      return {
        reasoner: { pose: "present", spot: "board", bubble: "check" },
        executor: { pose: "ready", spot: "desk", bubble: "none" },
        board: "approved",
      };
    case "running":
      return {
        reasoner: { pose: "idle", spot: "lounge", bubble: "none" },
        executor: i.permissionPending
          ? { pose: "attention", spot: "desk", bubble: "alert" }
          : {
              pose: executorPoseForTool(i.currentTool),
              spot: "desk",
              bubble: i.currentTool === null ? "gear" : "none",
            },
        board: "active",
      };
    case "completed":
      return { ...IDLE_SCENE, executor: { pose: "celebrate", spot: "desk", bubble: "check" }, board: "done" };
    case "failed":
      return { ...IDLE_SCENE, executor: { pose: "error", spot: "desk", bubble: "cross" }, board: "failed" };
    case "cancelled":
      return { ...IDLE_SCENE, board: "cancelled" };
  }
}
