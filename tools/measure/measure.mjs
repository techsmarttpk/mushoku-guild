// Phase 2 measurement harness (task 2.3). Zero dependencies (Node >= 20 built-ins + Windows PowerShell).
//
//   node tools/measure/measure.mjs --exe <path-to-mushoku-guild.exe> [--scenarios a,b,...] [--runs 3] [--gpu] [--out docs/measurements/phase2] [--tag name]
//
// For each scenario and run it launches the app, waits for the app's own "ready" marker (startup time),
// puts the window in the scenario's state, lets it settle, samples the app's PROCESS TREE once per second
// (app + every WebView2 process it owns; never claude.exe), then kills the tree. Results are raw JSON per run
// plus summary.json. Nothing here is estimated: every number comes from a sample or a timer.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[i + 1]) : dflt; };
const exe = opt("exe");
if (!exe || exe === true || !fs.existsSync(exe)) { console.error("usage: --exe <path to app exe> (must exist)"); process.exit(2); }
const runs = Number(opt("runs", 3));
const withGpu = argv.includes("--gpu");
const outDir = path.resolve(opt("out", "docs/measurements/phase2"));
const tag = opt("tag", "run");

const SCENARIOS = {
  "idle-focused":       { bench: "idle",   window: ["focus"],                    settle: 5, sample: 60, blurStops: false },
  "idle-blank":         { bench: "blank",  window: ["focus"],                    settle: 5, sample: 45, blurStops: false },
  "idle-static":        { bench: "static", window: ["focus"],                    settle: 5, sample: 45, blurStops: false },
  "idle-blur-visible":  { bench: "idle",   window: ["focus", "blur"],            settle: 5, sample: 45, blurStops: false },
  "idle-blur-stops":    { bench: "idle",   window: ["focus", "blur"],            settle: 5, sample: 45, blurStops: true },
  "idle-minimized":     { bench: "idle",   window: ["focus", "minimize"],        settle: 5, sample: 45, blurStops: false },
  "idle-hidden":        { bench: "idle",   window: ["focus", "hide"],            settle: 5, sample: 45, blurStops: false },
  "active-focused":     { bench: "active", window: ["focus"],                    settle: 3, sample: 35, blurStops: false },
};
const wanted = String(opt("scenarios", Object.keys(SCENARIOS).join(","))).split(",");
for (const s of wanted) if (!SCENARIOS[s]) { console.error("unknown scenario", s); process.exit(2); }

const ps = (file, args) => new Promise((res) => execFile("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, file), ...args], { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => res({ err, stdout: stdout.trim(), stderr: stderr.trim() })));
const psCmd = (cmd) => new Promise((res) => execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 60000 }, (err, stdout) => res(stdout.trim())));
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout: 60000 }, (err, stdout) => res({ err, stdout })));

const stat = (arr) => {
  const v = arr.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), median: q(0.5), p95: q(0.95), max: v[v.length - 1], min: v[0] };
};

async function environment() {
  const hw = await psCmd(`$c=Get-CimInstance Win32_Processor; $g=(Get-CimInstance Win32_VideoController | % { $_.Name + ' ' + $_.DriverVersion }) -join ' ; '; $b=Get-CimInstance Win32_Battery; $wv=(Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv; $p=(powercfg /getactivescheme) -replace '^.*:\\s*',''; @{cpu=$c.Name;logical=$c.NumberOfLogicalProcessors;gpus=$g;webview2=$wv;powerScheme=$p;batteryStatus=if($b){[string]$b.BatteryStatus}else{'none'}} | ConvertTo-Json -Compress`);
  let hwj = {}; try { hwj = JSON.parse(hw); } catch { hwj = { raw: hw }; }
  return { os: `${os.type()} ${os.release()} ${os.version?.() ?? ""}`.trim(), totalRamGB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, exe: path.basename(exe), exeSizeMB: +(fs.statSync(exe).size / 2 ** 20).toFixed(2), ...hwj, note: "batteryStatus 2 = on AC power" };
}

async function waitFor(file, timeoutMs, pred = () => true) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (fs.existsSync(file)) { try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (pred(j)) return j; } catch { /* file mid-write */ } }
    await sleep(25);
  }
  return null;
}

async function runOnce(name, def, runNo) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mushoku-measure-"));
  const base = path.join(tmp, "bench");
  // Two one-shot "mark" times inside the sampling window; the app records its frame counter at each.
  const firstMark = def.window.length * 1600 + def.settle * 1000 + 500;
  const marks = [firstMark, firstMark + def.sample * 1000 - 1500];
  const env = { ...process.env, MUSHOKU_BENCH_OUT: base, MUSHOKU_BENCH_SCENARIO: def.bench, MUSHOKU_BENCH_BLUR_STOPS: def.blurStops ? "1" : "0", MUSHOKU_BENCH_MARKS_MS: marks.join(",") };
  const t0 = performance.now();
  const child = spawn(exe, [], { env, cwd: tmp, stdio: "ignore" });
  const rec = { scenario: name, run: runNo, pid: child.pid, startedAtUnixMs: Date.now() };
  child.on("exit", (code) => { rec.exitedEarly = code; });
  const ready = await waitFor(`${base}.ready.json`, 60000);
  rec.startupMs = ready ? +(performance.now() - t0).toFixed(1) : null;
  rec.sinceMainMs = ready?.sinceMainMs ?? null;
  if (!ready) { rec.error = "app never reported ready"; await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]); return rec; }

  rec.windowStates = [];
  for (const action of def.window) {
    const r = await ps("window.ps1", ["-TargetPid", String(child.pid), "-Action", action]);
    rec.windowStates.push(r.stdout || r.stderr || String(r.err));
  }
  await sleep(def.settle * 1000);

  const samples = [];
  const args = ["-RootPid", String(child.pid), "-IntervalMs", "1000", "-DurationSec", String(def.sample), ...(withGpu ? ["-Gpu"] : [])];
  await new Promise((resolve) => {
    const sp = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "sampler.ps1"), ...args], { windowsHide: true });
    let buf = "";
    sp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { samples.push(JSON.parse(l)); } catch { /* ignore partial */ } } } });
    sp.stderr.on("data", (d) => { rec.samplerStderr = (rec.samplerStderr ?? "") + d; });
    sp.on("close", resolve);
  });
  rec.samples = samples;

  if (def.bench === "active") {
    rec.report = await waitFor(`${base}.report.json`, 40000, (j) => j.stream);
  } else {
    rec.report = await waitFor(`${base}.report.json`, 500);
  }
  const markEvents = (rec.report?.lifecycle ?? []).filter((e) => e.kind === "mark");
  if (markEvents.length >= 2) {
    const a = markEvents[0], b = markEvents[markEvents.length - 1];
    rec.measuredFps = +(((b.framesTicked - a.framesTicked) / ((b.atMs - a.atMs) / 1000))).toFixed(2);
    rec.measuredRenderFps = +(((b.framesRendered - a.framesRendered) / ((b.atMs - a.atMs) / 1000))).toFixed(2);
    rec.markWindowSec = +((b.atMs - a.atMs) / 1000).toFixed(1);
  } else {
    rec.measuredFps = null;
  }
  rec.survivedSampling = child.exitCode === null;
  await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  await sleep(1500);
  fs.rmSync(tmp, { recursive: true, force: true });

  rec.summary = {
    cpuPct: stat(samples.map((s) => s.cpuPct)),
    wsMB: stat(samples.map((s) => s.wsMB)),
    privMB: stat(samples.map((s) => s.privMB)),
    procs: stat(samples.map((s) => s.procs)),
  };
  if (withGpu) {
    const keys = new Set(samples.flatMap((s) => Object.keys(s.gpu ?? {})));
    rec.summary.gpu = Object.fromEntries([...keys].map((k) => [k, stat(samples.map((s) => s.gpu?.[k] ?? 0))]));
  }
  return rec;
}

fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
const env = await environment();
console.log("environment:", JSON.stringify(env));
const all = [];
for (const name of wanted) {
  for (let r = 1; r <= runs; r++) {
    process.stdout.write(`${name} run ${r}/${runs} ... `);
    const rec = await runOnce(name, SCENARIOS[name], r);
    all.push(rec);
    fs.writeFileSync(path.join(outDir, "raw", `${tag}-${name}-run${r}.json`), JSON.stringify(rec));
    console.log(rec.error ? `ERROR ${rec.error}` : `startup ${rec.startupMs} ms | cpu mean ${rec.summary.cpuPct.mean}% | ws mean ${rec.summary.wsMB.mean} MB | priv mean ${rec.summary.privMB.mean} MB | procs max ${rec.summary.procs.max} | ticks/s ${rec.measuredFps} | renders/s ${rec.measuredRenderFps}`);
  }
}

// Aggregate across runs per scenario.
const rows = wanted.map((name) => {
  const rs = all.filter((r) => r.scenario === name && !r.error);
  const m = (f) => stat(rs.map(f));
  return {
    scenario: name, runs: rs.length,
    startupMs: m((r) => r.startupMs),
    cpuMeanPct: m((r) => r.summary.cpuPct.mean), cpuMaxPct: m((r) => r.summary.cpuPct.max),
    wsMeanMB: m((r) => r.summary.wsMB.mean), wsMaxMB: m((r) => r.summary.wsMB.max),
    privMeanMB: m((r) => r.summary.privMB.mean),
    procsMax: m((r) => r.summary.procs.max),
    fps: m((r) => r.measuredFps),
    renderFps: m((r) => r.measuredRenderFps),
    latency: rs.map((r) => r.report?.stream).filter(Boolean),
  };
});
fs.writeFileSync(path.join(outDir, `${tag}-summary.json`), JSON.stringify({ env, rows }, null, 1));
console.log("\n| scenario | runs | startup ms (mean/max) | CPU % total (mean of means / worst max) | RAM ws MB (mean / worst max) | private MB (mean) | procs (max) | ticks/s (mean) | renders/s (mean) |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.scenario} | ${r.runs} | ${r.startupMs.mean} / ${r.startupMs.max} | ${r.cpuMeanPct.mean} / ${r.cpuMaxPct.max} | ${r.wsMeanMB.mean} / ${r.wsMaxMB.max} | ${r.privMeanMB.mean} | ${r.procsMax.max} | ${r.fps.n ? r.fps.mean : "n/a"} | ${r.renderFps.n ? r.renderFps.mean : "n/a"} |`);
}
for (const r of rows) for (const l of r.latency) console.log(`latency (${r.scenario}): ${JSON.stringify(l)}`);
process.exit(0);
