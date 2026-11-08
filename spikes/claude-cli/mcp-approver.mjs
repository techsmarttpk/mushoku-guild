// THROWAWAY. Minimal stdio MCP server used only to probe `--permission-prompt-tool`.
// It logs the arguments it receives (tool name + input; no credentials) and answers allow/deny per APPROVER_MODE.
import fs from "node:fs";
import readline from "node:readline";

const MODE = process.env.APPROVER_MODE || "deny";
const LOG = process.env.APPROVER_LOG;
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n"); };
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log({ rpc: m.method, id: m.id });
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "approver", version: "0.0.1" } } });
  } else if (m.method === "tools/list") {
    send({ id: m.id, result: { tools: [{
      name: "approve", description: "Decides whether Claude Code may run a tool.",
      inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
    }] } });
  } else if (m.method === "tools/call") {
    const a = m.params?.arguments || {};
    log({ approvalRequest: { keys: Object.keys(a), tool_name: a.tool_name, input: a.input, tool_use_id: a.tool_use_id } });
    const decision = MODE === "allow"
      ? { behavior: "allow", updatedInput: a.input }
      : { behavior: "deny", message: "Denied by Mushoku Guild spike approver." };
    send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
  } else if (m.method === "ping") {
    send({ id: m.id, result: {} });
  } else if (m.id !== undefined) {
    send({ id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
