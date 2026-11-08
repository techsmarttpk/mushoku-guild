// Captures README screenshots from the real app against a small disposable repository (never a real project).
//   node tools/e2e/shots.mjs <exe> <work-dir> <out-dir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./cdp.mjs";

const [exe, work, out] = process.argv.slice(2);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const repo = path.join(work, "sample-app");
const G = ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (...a) => execFileSync("git", [...G, ...a], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "docs"));
fs.writeFileSync(path.join(repo, "README.md"), "# Sample App\n\nA small demo repository used for screenshots.\n");
fs.writeFileSync(path.join(repo, "src/app.ts"), 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nexport const VERSION = "1.0.0";\n');
fs.writeFileSync(path.join(repo, "src/util.py"), "def add(a, b):\n    return a + b\n");
fs.writeFileSync(path.join(repo, "docs/architecture.md"), "# Architecture\n\nHow a request flows through the sample app.\n\n```mermaid\nflowchart LR\n    U[User] --> UI[Frontend]\n    UI --> API[Backend]\n    API --> DB[(Database)]\n    API --> Q{{Queue}}\n```\n\n```mermaid\nsequenceDiagram\n    participant C as Client\n    participant S as Server\n    C->>S: GET /items\n    S-->>C: 200 OK\n```\n");
git("init", "-q"); git("add", "-A"); git("commit", "-qm", "Initial commit");
git("switch", "-q", "-c", "feature/login");
fs.writeFileSync(path.join(repo, "src/login.ts"), "export const login = true;\n");
git("add", "-A"); git("commit", "-qm", "Add login");
git("switch", "-q", "main");
fs.writeFileSync(path.join(repo, "src/util.py"), "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n");
git("add", "-A"); git("commit", "-qm", "Add subtraction helper");
git("merge", "-q", "--no-ff", "-m", "Merge feature/login", "feature/login");
fs.appendFileSync(path.join(repo, "src/app.ts"), "export const DEBUG = false;\n");

const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9235", MUSHOKU_DEV_SEED_PROJECT: repo, MUSHOKU_DEV_SEED_PROMPT: "Add input validation to the greet function in src/app.ts and write a unit test for it." }, stdio: "ignore" });
try {
  const c = await connect(9235);
  await c.waitFor("!!document.querySelector('canvas')", 30000);
  await sleep(2500);
  await c.click("Quests");
  await sleep(1500);
  await c.screenshot(`${out}/cafe-quests.png`);
  await c.click("Library");
  await c.waitFor("!!document.querySelector('.library-host canvas')", 15000);
  await sleep(1500);
  await c.screenshot(`${out}/library-shelf.png`);
  await c.click("Repo");
  await c.waitFor("!!document.querySelector('.branch-btn')", 20000);
  await sleep(1500);
  await c.evaluate("[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.includes('src'))?.click()");
  await sleep(700);
  await c.evaluate("[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.trim().endsWith('app.ts'))?.click()");
  await c.waitFor("!!document.querySelector('.cm-content')", 20000);
  await sleep(1500);
  await c.screenshot(`${out}/repo-editor.png`);
  await c.click("Graph");
  await c.waitFor("document.querySelectorAll('.graph-row').length >= 4", 15000, 400);
  await c.evaluate("[...document.querySelectorAll('.graph-row')].find(r=>r.innerText.includes('Merge feature/login'))?.click()");
  await sleep(1200);
  await c.screenshot(`${out}/repo-git-graph.png`);
  await c.click("Library");
  await c.waitFor("!!document.querySelector('.library-host canvas')", 15000);
  await sleep(1200);
  const r = await c.evaluate("(()=>{const r=document.querySelector('.library-host canvas').getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}})()");
  for (let i = 0; i < 3; i++) {
    await c.mouse(r.x + ((25 + 34 * i) * r.w) / 288, r.y + (50 * r.h) / 176);
    await sleep(700);
    if (/Architecture/.test(await c.evaluate("document.querySelector('.parchment')?.innerText ?? ''"))) break;
    if (await c.evaluate("!!document.querySelector('.parchment')")) await c.click("← Back to bookshelf");
  }
  await c.waitFor("document.querySelectorAll('.mermaid-block svg').length >= 2", 40000, 500).catch(() => undefined);
  await sleep(1200);
  await c.screenshot(`${out}/library-mermaid.png`);
  c.close();
} finally {
  try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}
