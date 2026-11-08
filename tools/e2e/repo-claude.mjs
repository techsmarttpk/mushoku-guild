// A REAL Claude Code quest changes Git (new branch, new file, commit) in a temporary repository while the Repo tab is
// open. The tab must follow by itself: branch, explorer, status and graph, with no refresh clicks.
//   node tools/e2e/repo-claude.mjs <exe> <work-dir> <out-dir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./cdp.mjs";

const [exe, work, out] = process.argv.slice(2);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const repo = path.join(work, "claude-demo");
const G = ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (...a) => execFileSync("git", [...G, ...a], { cwd: repo, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(repo);
git("init", "-q");
fs.writeFileSync(path.join(repo, "README.md"), "# Claude demo\n");
git("add", "-A");
git("commit", "-qm", "initial commit");
const PROMPT = "Run these git commands one at a time with Bash, in this order, and report briefly: 1) git switch -c feature/by-claude  2) create a file named claude-note.txt containing the word hello (use the Write tool)  3) git add claude-note.txt  4) git commit -m \"Add claude-note from a quest\"";
const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9234", MUSHOKU_DEV_SEED_PROJECT: repo, MUSHOKU_DEV_SEED_PROMPT: PROMPT }, stdio: "ignore" });
let code = 0;
const check = (n, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", n, extra);
  if (!ok) code = 1;
};
try {
  const c = await connect(9234);
  await c.waitFor("!!document.querySelector('canvas')", 30000);
  await sleep(1200);
  await c.click("Quests");
  await c.click("Seeded test quest");
  await c.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Start Claude Code') && !b.disabled)", 90000);
  await c.click("Start Claude Code");
  await sleep(1500);
  await c.click("Repo");
  await c.waitFor("!!document.querySelector('.branch-btn')", 20000);
  console.log("   branch at start:", (await c.evaluate("document.querySelector('.branch-name').innerText")).trim());
  const t0 = Date.now();
  let sawBranch = false;
  let sawDirty = false;
  while (Date.now() - t0 < 240000) {
    if (await c.evaluate("!!document.querySelector('.dialog')")) await c.click("Allow once");
    const b = (await c.evaluate("document.querySelector('.branch-name')?.innerText ?? ''")).trim();
    if (b === "feature/by-claude") sawBranch = true;
    if (/modified|staged|untracked/.test(await c.evaluate("document.querySelector('.repo-top')?.innerText ?? ''"))) sawDirty = true;
    if (sawBranch && git("log", "-1", "--format=%s").includes("claude-note")) break;
    await sleep(500);
  }
  await sleep(4500);
  check("the branch Claude created shows in the toolbar without any click", sawBranch);
  check("the working tree state changed visibly while Claude worked", sawDirty);
  check("Claude really committed", /claude-note/.test(git("log", "-1", "--format=%s")));
  const top = await c.evaluate("document.querySelector('.repo-top').innerText");
  check("after the commit the Repo tab shows a clean tree on the new branch", /feature\/by-claude/.test(top) && /clean/.test(top), top.replace(/\n/g, " | ").slice(0, 160));
  check("the explorer lists the file Claude created", /claude-note\.txt/.test(await c.evaluate("[...document.querySelectorAll('.tree-name')].map(e=>e.textContent).join(',')")));
  await c.click("Graph");
  await c.waitFor("document.querySelector('.graph-list')?.innerText.includes('Add claude-note')", 15000, 500);
  check("the new commit is in the graph", /Add claude-note from a quest/.test(await c.evaluate("document.querySelector('.graph-list').innerText")));
  await c.screenshot(`${out}/claude-graph.png`);
  await c.click("Quests");
  const st = await c.evaluate("document.querySelector('.task-head .pill')?.textContent ?? ''");
  console.log("   quest status:", st);
  console.log("page errors:", JSON.stringify(c.errors.slice(0, 3)));
  c.close();
} catch (e) {
  console.log("E2E ERROR:", e.message);
  code = 1;
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* gone */
  }
}
process.exit(code);
