// THROWAWAY Phase 1 experiment. Not production code. Zero dependencies (Node >= 20 built-ins).
// Validates driving the user's native Windows Claude Code CLI (print mode, stream-json) as a child process.
//
// Rules this script follows: no API key, no Agent SDK, no WSL, no --dangerously-skip-permissions,
// never reads or writes Claude credential files, never prints env values, does not modify the binary.
//
//   node spikes/claude-cli/spike.mjs discover
//   node spikes/claude-cli/spike.mjs run <deny|allow|cancel-kill|cancel-tree|mcp-deny|mcp-allow>
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGDIR = process.env.SPIKE_LOGDIR || path.join(os.tmpdir(), "mushoku-claude-spike-logs");
fs.mkdirSync(LOGDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => res({ err, stdout, stderr })));
const ps = (script) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);

// ---------- 1. executable discovery ----------
export async function discover() {
  const out = { candidates: [], chosen: null, notes: [] };
  const seen = new Set();
  const add = (p, how) => { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.candidates.push({ path: p, how }); } };
  if (process.env.MUSHOKU_CLAUDE_PATH) add(process.env.MUSHOKU_CLAUDE_PATH, "env MUSHOKU_CLAUDE_PATH (user override)");
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, "claude.exe");
    if (fs.existsSync(p)) add(p, "PATH search for claude.exe");
    for (const shim of ["claude.cmd", "claude.ps1"]) if (fs.existsSync(path.join(dir, shim))) out.notes.push(`shim found (not used): ${path.join(dir, shim)}`);
  }
  const home = os.homedir();
  add(path.join(home, ".local", "bin", "claude.exe"), "native installer default (~/.local/bin)");
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.exe"), "fallback guess (unverified location)");
  for (const c of out.candidates) {
    c.exists = fs.existsSync(c.path);
    if (!c.exists) continue;
    const st = fs.statSync(c.path);
    c.sizeMB = Math.round(st.size / 1048576);
    const v = await run(c.path, ["--version"]);
    c.version = (v.stdout || "").trim();
    c.versionOk = /^\d+\.\d+\.\d+/.test(c.version);
    const sig = await ps(`$s=Get-AuthenticodeSignature -LiteralPath '${c.path.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
    c.signature = (sig.stdout || "").trim();
    if (!out.chosen && c.versionOk) out.chosen = c;
  }
  if (out.chosen) {
    const a = await run(out.chosen.path, ["auth", "status"]);
    try { const j = JSON.parse(a.stdout); out.auth = { loggedIn: j.loggedIn, authMethod: j.authMethod, apiProvider: j.apiProvider, exitCode: a.err ? a.err.code : 0 }; }
    catch { out.auth = { raw: (a.stdout || a.stderr).slice(0, 200) }; }
  }
  out.env = {
    ANTHROPIC_vars_present: Object.keys(process.env).filter((k) => /^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(k)),
    claude_session_vars_that_will_be_scrubbed: Object.keys(process.env).filter(isClaudeSessionVar),
  };
  const gb = await run("where", ["bash"]); const gg = await run("where", ["git"]);
  out.env.gitBashOrBashOnPath = (gb.stdout || "").trim().split(/\r?\n/).slice(0, 2);
  out.env.gitOnPath = (gg.stdout || "").trim().split(/\r?\n/).slice(0, 1);
  return out;
}

// Variables describing a *parent* Claude Code session. A desktop app would not have them; scrub them (names only logged).
const isClaudeSessionVar = (k) => /^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT|AI_AGENT$)/.test(k) && k !== "CLAUDE_CODE_OAUTH_TOKEN";
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!isClaudeSessionVar(k)) env[k] = v;
  return { ...env, ...extra };
}

// ---------- process tree + resource sampling (PowerShell CIM; one query per sample) ----------
async function snapshot() {
  const r = await ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress");
  try { const j = JSON.parse(r.stdout); return Array.isArray(j) ? j : [j]; } catch { return []; }
}
function descendants(all, rootPid) {
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const out = []; const stack = [rootPid];
  while (stack.length) { const id = stack.pop(); for (const c of kids.get(id) || []) { out.push(c); stack.push(c.ProcessId); } }
  return out;
}

// ---------- 2. launch + stream-json parsing ----------
function summarizeEvent(ev) {
  const t = ev.type, st = ev.subtype ? "/" + ev.subtype : "";
  if (t === "assistant" || t === "user") {
    const blocks = (ev.message?.content || []);
    const kinds = Array.isArray(blocks) ? blocks.map((b) => b.type + (b.name ? ":" + b.name : "") + (b.type === "tool_result" ? (b.is_error ? "(error)" : "(ok)") : "")) : ["text"];
    return `${t}[${kinds.join(",")}]`;
  }
  if (t === "stream_event") return `stream_event:${ev.event?.type}${ev.event?.delta?.type ? "/" + ev.event.delta.type : ""}`;
  return t + st;
}

export async function launch({ exe, cwd, prompt, args = [], name, onEvent, extraEnv = {}, sample = true }) {
  const full = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "project,local", "--model", process.env.SPIKE_MODEL || "haiku", ...args];
  const t0 = Date.now();
  const child = spawn(exe, full, { cwd, env: cleanEnv(extraEnv), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const rec = { name, pid: child.pid, args: full, counts: {}, sequence: [], events: [], stderr: "", firstEventMs: null, peakMB: 0, peakProcs: 0, samples: 0 };
  const eventLog = fs.createWriteStream(path.join(LOGDIR, `${name}.jsonl`));
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      eventLog.write(line + "\n");
      let ev; try { ev = JSON.parse(line); } catch { rec.nonJson = (rec.nonJson || 0) + 1; continue; }
      if (rec.firstEventMs === null) rec.firstEventMs = Date.now() - t0;
      const s = summarizeEvent(ev);
      rec.counts[s] = (rec.counts[s] || 0) + 1;
      if (!rec.sequence.length || rec.sequence[rec.sequence.length - 1] !== s) rec.sequence.push(s);
      rec.events.push(ev);
      if (ev.type === "result") rec.result = ev;
      if (ev.type === "system" && ev.subtype === "init") rec.init = ev;
      if (ev.type === "rate_limit_event") rec.rate = ev.rate_limit_info;
      onEvent?.(ev, rec, child);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { rec.stderr += d; });
  let sampling = sample;
  (async () => {
    while (sampling) {
      const all = await snapshot(); const d = descendants(all, child.pid);
      const self = all.find((p) => p.ProcessId === child.pid);
      const procs = [self, ...d].filter(Boolean);
      const mb = procs.reduce((a, p) => a + (p.WorkingSetSize || 0), 0) / 1048576;
      rec.samples++; rec.peakMB = Math.max(rec.peakMB, Math.round(mb)); rec.peakProcs = Math.max(rec.peakProcs, procs.length);
      rec.lastTree = procs.map((p) => p.Name);
      await sleep(700);
    }
  })();
  child.stdin.on("error", () => {});
  if (prompt !== null) child.stdin.end(prompt);
  rec.done = new Promise((res) => child.on("close", (code, signal) => { rec.exitCode = code; rec.signal = signal; rec.wallMs = Date.now() - t0; sampling = false; eventLog.end(); res(rec); }));
  rec.child = child;
  return rec;
}

function report(rec) {
  const r = rec.result;
  const init = rec.init;
  console.log(`\n--- ${rec.name} ---`);
  console.log(`exit code: ${rec.exitCode}  signal: ${rec.signal}  wall: ${rec.wallMs} ms  first event: ${rec.firstEventMs} ms`);
  if (init) console.log(`init: version=${init.claude_code_version} model=${init.model} permissionMode=${init.permissionMode} apiKeySource=${init.apiKeySource} tools=${init.tools?.length} mcp=${JSON.stringify((init.mcp_servers || []).map((m) => m.name + ":" + m.status))}`);
  console.log(`event sequence: ${rec.sequence.join(" > ")}`);
  console.log(`event counts: ${JSON.stringify(rec.counts)}`);
  if (r) {
    const u = r.usage || {};
    console.log(`result: subtype=${r.subtype} is_error=${r.is_error} terminal_reason=${r.terminal_reason} num_turns=${r.num_turns} cost_est=$${r.total_cost_usd} permission_denials=${JSON.stringify((r.permission_denials || []).map((d) => d.tool_name))}`);
    console.log(`tokens: in=${u.input_tokens} out=${u.output_tokens} cache_create=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens}  result_text=${JSON.stringify(String(r.result).slice(0, 160))}`);
  } else console.log("result: (no result event received)");
  if (rec.rate) console.log(`rate_limit_event: ${JSON.stringify(rec.rate).slice(0, 400)}`);
  console.log(`resources: peak working set (process tree) ≈ ${rec.peakMB} MB, peak processes ${rec.peakProcs}, samples ${rec.samples}`);
  if (rec.stderr.trim()) console.log(`stderr (first 400): ${rec.stderr.trim().slice(0, 400)}`);
  if (rec.nonJson) console.log(`non-JSON stdout lines: ${rec.nonJson}`);
}

function makeProject(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mushoku-test-project-${tag}-`));
  fs.writeFileSync(path.join(dir, "README.txt"), "Test project for the Mushoku Guild Claude CLI spike.\n");
  return dir;
}

// ---------- scenarios ----------
const HELLO = "Create a file named hello.txt in the current directory containing exactly the text: hello from mushoku guild. Then reply DONE.";

async function scenario(which, exe) {
  const cwd = makeProject(which);
  console.log(`test project: ${cwd}`);
  const toolsFlag = ["--tools", "Read,Write,Bash"];
  if (which === "deny") {
    const rec = await launch({ exe, cwd, name: which, prompt: HELLO, args: [...toolsFlag, "--max-turns", "4"] });
    await rec.done; report(rec);
    console.log(`hello.txt exists: ${fs.existsSync(path.join(cwd, "hello.txt"))}`);
    return rec;
  }
  if (which === "allow") {
    const rec = await launch({ exe, cwd, name: which, prompt: HELLO, args: [...toolsFlag, "--permission-mode", "acceptEdits", "--max-turns", "4"] });
    await rec.done; report(rec);
    const f = path.join(cwd, "hello.txt");
    console.log(`hello.txt exists: ${fs.existsSync(f)} content: ${fs.existsSync(f) ? JSON.stringify(fs.readFileSync(f, "utf8")) : "-"}`);
    return rec;
  }
  if (which === "cancel-kill") {
    const t = { cancelAt: 0 };
    const rec = await launch({ exe, cwd, name: which, prompt: "Write a 1500-word story about a café of adventurers. Do not use any tools.", args: ["--tools", "", "--include-partial-messages", "--max-turns", "2"],
      onEvent: (ev, r, child) => { if (!t.cancelAt && ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") { t.cancelAt = Date.now(); r.cancelMethod = "child.kill()"; child.kill(); } } });
    await rec.done; report(rec);
    console.log(`cancel issued after ${t.cancelAt ? t.cancelAt - (Date.now() - rec.wallMs) : "n/a"} ms from start; process ended ${Date.now() - t.cancelAt} ms ago-ish; result event present: ${!!rec.result}`);
    return rec;
  }
  if (which === "interrupt") {
    // Graceful cancel via stream-json input. The control_request shape is NOT in the official docs; this probes it.
    const st = { sent: 0, resultAt: 0 };
    const rec = await launch({ exe, cwd, name: which, prompt: null, args: ["--tools", "", "--input-format", "stream-json", "--include-partial-messages", "--max-turns", "2"],
      onEvent: (ev, r, child) => {
        if (ev.type === "system" && ev.subtype === "init") { r.capabilities = ev.capabilities; }
        if (!st.sent && ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") {
          st.sent = Date.now(); r.interruptSentAt = st.sent;
          child.stdin.write(JSON.stringify({ type: "control_request", request_id: "spike-int-1", request: { subtype: "interrupt" } }) + "\n");
        }
        if (ev.type === "control_response" || ev.type === "result") { r.afterInterrupt = (r.afterInterrupt || []).concat(summarizeEvent(ev) + ":" + JSON.stringify(ev).slice(0, 220)); if (ev.type === "result" && !st.resultAt) { st.resultAt = Date.now(); child.stdin.end(); } }
      } });
    rec.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Write a 1500-word story about a café of adventurers. Do not use any tools." } }) + "\n");
    const killer = setTimeout(() => { rec.hardKilled = true; run("taskkill", ["/PID", String(rec.pid), "/T", "/F"]); }, 45000);
    await rec.done; clearTimeout(killer); report(rec);
    console.log(`init.capabilities: ${JSON.stringify(rec.capabilities)}`);
    console.log(`interrupt sent: ${!!st.sent}; events after interrupt: ${JSON.stringify(rec.afterInterrupt)}; hard-killed: ${!!rec.hardKilled}`);
    return rec;
  }
  if (which === "cancel-tree") {
    const marker = "47";
    let state = { cancelled: false };
    const method = process.env.CANCEL_METHOD || "taskkill-tree";
    const rec = await launch({ exe, cwd, name: which + "-" + method, prompt: `Use the Bash tool to run exactly this command and wait for it: ping -n ${marker} 127.0.0.1 . Then reply DONE.`, args: ["--tools", "Bash", "--allowedTools", "Bash(ping *)", "--max-turns", "3"],
      onEvent: async (ev, r, child) => {
        if (state.cancelled) return;
        const isBashUse = ev.type === "assistant" && (ev.message?.content || []).some((b) => b.type === "tool_use");
        if (!isBashUse) return;
        state.cancelled = true;
        await sleep(4000); // let the tool actually start
        const all = await snapshot();
        const tree = descendants(all, child.pid);
        r.treeBeforeCancel = tree.map((p) => p.Name);
        r.pingBefore = all.filter((p) => /ping(\.exe)?$/i.test(p.Name) && (p.CommandLine || "").includes(`-n ${marker}`)).length;
        r.cancelMethod = method;
        if (method === "kill") child.kill();
        else await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      } });
    await rec.done; report(rec);
    await sleep(1500);
    const after = await snapshot();
    const orphans = after.filter((p) => /ping(\.exe)?$/i.test(p.Name) && (p.CommandLine || "").includes(`-n ${marker}`));
    console.log(`cancel method: ${rec.cancelMethod}; tree before cancel: ${JSON.stringify(rec.treeBeforeCancel)}; ping.exe before: ${rec.pingBefore}; orphan ping.exe after: ${orphans.length}`);
    for (const o of orphans) await run("taskkill", ["/PID", String(o.ProcessId), "/T", "/F"]); // clean up
    return rec;
  }
  if (which === "mcp-deny" || which === "mcp-allow") {
    const mode = which === "mcp-allow" ? "allow" : "deny";
    const alog = path.join(LOGDIR, `${which}.approver.jsonl`); fs.rmSync(alog, { force: true });
    const cfg = path.join(LOGDIR, `${which}.mcp.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { approver: { command: process.execPath, args: [path.join(HERE, "mcp-approver.mjs")], env: { APPROVER_MODE: mode, APPROVER_LOG: alog } } } }));
    const rec = await launch({ exe, cwd, name: which, prompt: HELLO, args: [...toolsFlag, "--mcp-config", cfg, "--strict-mcp-config", "--permission-prompt-tool", "mcp__approver__approve", "--max-turns", "5"] });
    await rec.done; report(rec);
    console.log(`hello.txt exists: ${fs.existsSync(path.join(cwd, "hello.txt"))}`);
    console.log("approver log:"); console.log(fs.existsSync(alog) ? fs.readFileSync(alog, "utf8").trim().split("\n").map((l) => "  " + l.slice(0, 300)).join("\n") : "  (approver never invoked)");
    return rec;
  }
  throw new Error("unknown scenario " + which);
}

// ---------- main ----------
const [cmd, arg] = process.argv.slice(2);
if (cmd === "discover") {
  console.log(JSON.stringify(await discover(), null, 2));
} else if (cmd === "run") {
  const d = await discover();
  if (!d.chosen) { console.log("no usable claude.exe found"); process.exit(1); }
  console.log(`using ${d.chosen.path} (${d.chosen.version}); signature: ${d.chosen.signature}`);
  const before = d.auth;
  await scenario(arg, d.chosen.path);
  const a = await run(d.chosen.path, ["auth", "status"]);
  let after; try { const j = JSON.parse(a.stdout); after = { loggedIn: j.loggedIn, authMethod: j.authMethod }; } catch { after = a.stdout.slice(0, 100); }
  console.log(`auth before: ${JSON.stringify({ loggedIn: before?.loggedIn, authMethod: before?.authMethod })}  after: ${JSON.stringify(after)}`);
} else {
  console.log("usage: node spike.mjs discover | run <deny|allow|cancel-kill|cancel-tree|mcp-deny|mcp-allow>");
}
process.exit(0);
