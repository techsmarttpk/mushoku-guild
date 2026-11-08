// Phase 3 resource measurement of the REAL app (release build with --features dev-seed, never shipped).
//   node tools/measure/phase3.mjs <exe> <project-dir> <out.json>
// Phases: startup (spawn -> canvas present, polled every 25 ms through the WebView debug port), idle
// (café open, nothing running, 45 s), minimised (30 s), active (a real Claude Code run, permission prompts
// answered automatically by clicking Allow). CPU is % of TOTAL machine CPU; privMB is the ADR-0012 amendment A
// metric; wsMB (summed working sets) is reported beside it. `claude.exe` is NOT part of the app tree.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../e2e/cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [exe, project, outFile] = process.argv.slice(2);
const PORT = 9227;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prompt =
  "Read math.js and README.md, then fix math.js so add(a, b) returns a + b, add a subtract(a, b) function with a short comment, and create notes.txt listing the exported functions. Keep the answer brief.";

function sample(rootPid, seconds) {
  return new Promise((resolve) => {
    const rows = [];
    const sp = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "sampler.ps1"), "-RootPid", String(rootPid), "-DurationSec", String(seconds)], { windowsHide: true });
    let buf = "";
    sp.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try {
          const j = JSON.parse(line);
          if (j.cpuPct !== null && j.cpuPct !== undefined) rows.push(j);
        } catch {
          /* ignore */
        }
      }
    });
    sp.on("close", () => resolve(rows));
  });
}
const stats = (rows) => {
  const f = (k) => rows.map((r) => r[k]).filter((v) => typeof v === "number");
  const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null);
  const max = (a) => (a.length ? Math.max(...a) : null);
  return { samples: rows.length, cpuMean: mean(f("cpuPct")), cpuMax: max(f("cpuPct")), privMBmean: mean(f("privMB")), privMBmax: max(f("privMB")), wsMBmean: mean(f("wsMB")), procsMax: max(f("procs")) };
};

const result = { env: { exe, note: "release build with dev-seed feature; one machine; AC power; other apps running" } };
const t0 = Date.now();
const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, MUSHOKU_DEV_SEED_PROJECT: project, MUSHOKU_DEV_SEED_PROMPT: prompt }, stdio: "ignore" });
try {
  const c = await connect(PORT, 60000);
  while (!(await c.evaluate("!!document.querySelector('canvas')").catch(() => false))) await sleep(25);
  result.startupMs = Date.now() - t0;
  await sleep(8000);
  result.idle = stats(await sample(app.pid, 45));
  const diag = await c.evaluate("document.querySelectorAll('canvas').length");
  result.canvasCount = diag;

  // active: start the seeded run while sampling
  await c.click("Log");
  await c.waitFor("[...document.querySelectorAll('.list-item')].some(e=>e.textContent.includes('Seeded'))", 10000);
  await c.click("Seeded test quest");
  await c.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Start Claude Code') && !b.disabled)", 90000);
  const sampling = sample(app.pid, 70);
  await c.click("Start Claude Code");
  const runStart = Date.now();
  while (Date.now() - runStart < 66000) {
    if (await c.evaluate("!!document.querySelector('.dialog')")) await c.click("Allow once");
    const st = await c.evaluate("document.querySelector('.pill')?.textContent ?? ''");
    if (/Completed|Failed|Cancelled/.test(st)) {
      result.runMs = Date.now() - runStart;
      result.runEnd = st;
      break;
    }
    await sleep(300);
  }
  const rows = await sampling;
  const runSeconds = Math.ceil((result.runMs ?? 66000) / 1000);
  result.active = stats(rows.slice(0, Math.max(1, runSeconds)));
  c.close();
} catch (e) {
  result.error = String(e.message ?? e);
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* gone */
  }
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
