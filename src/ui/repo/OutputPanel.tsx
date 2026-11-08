import { useEffect, useRef, useState } from "react";
import type { OutputLine } from "../../domain/types.ts";
import { api, toProviderError } from "../../ipc.ts";

/**
 * Process output viewer. It shows Git operation output and the output of commands started here, with
 * cancellation. It is NOT a terminal: there is no interactive input and no terminal emulation.
 */
export function OutputPanel(props: { projectId: number; lines: OutputLine[]; claudeLines: string[]; trusted: boolean; onClear: () => void }) {
  const [tab, setTab] = useState<"git" | "cmd" | "claude">("git");
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const shown = props.lines.filter((l) => (tab === "git" ? l.source === "git" : tab === "cmd" ? l.source === "cmd" : false));
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, tab, props.claudeLines.length]);
  // a command is running until its exit line arrives
  useEffect(() => {
    const exited = new Set(props.lines.filter((l) => l.source === "cmd" && /^\[exit code/.test(l.text)).map((l) => l.runId));
    setRunning((r) => r.filter((id) => !exited.has(id)));
  }, [props.lines]);
  const start = async (): Promise<void> => {
    if (!cmd.trim()) return;
    setErr(null);
    try {
      const id = await api.cmdRun(props.projectId, cmd.trim());
      setRunning((r) => [...r, id]);
      setCmd("");
      setTab("cmd");
    } catch (e) {
      setErr(toProviderError(e).message);
    }
  };
  return (
    <div className="output">
      <div className="output-tabs">
        {(["git", "cmd", "claude"] as const).map((t) => (
          <button key={t} className={`otab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t === "git" ? "Git output" : t === "cmd" ? `Commands${running.length ? ` (${running.length} running)` : ""}` : "Claude activity"}
          </button>
        ))}
        <span className="grow" />
        <button className="link" onClick={props.onClear}>clear</button>
      </div>
      {tab === "cmd" && (
        <form className="cmd-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <span className="mono">&gt;</span>
          <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={props.trusted ? "Run a command in the repository, for example: npm test (output only, not a terminal)" : "Trust the repository (Guild tab → Permissions) to run commands here"} disabled={!props.trusted} aria-label="Command to run" />
          <button className="btn" disabled={!props.trusted || !cmd.trim()}>Run</button>
          {running.map((id) => (
            <button key={id} type="button" className="btn btn-danger" onClick={() => void api.cmdCancel(id)}>Stop #{id}</button>
          ))}
        </form>
      )}
      {err && <div className="note note-error">{err}</div>}
      <div className="output-body mono" role="log" aria-live="polite">
        {tab === "claude" ? props.claudeLines.map((l, i) => <div key={i}>{l}</div>) : shown.map((l) => <div key={l.id} className={`ol ol-${l.stream}`}>{l.text}</div>)}
        {((tab === "claude" && props.claudeLines.length === 0) || (tab !== "claude" && shown.length === 0)) && <div className="muted">{tab === "git" ? "Git operations and their output appear here." : tab === "cmd" ? "Output of commands you run here appears here." : "What Claude does in quests (tool calls, commands, launched processes) appears here."}</div>}
        <div ref={end} />
      </div>
    </div>
  );
}
