// Checks the Claude in Chrome integration in the real app: Guild card state, the enable toggle, and that a quest
// started with the toggle on really launches Claude Code with the official --chrome flag (the init event then lists
// the claude-in-chrome server). It does not drive the browser. Debug build with --features dev-seed.
//   node tools/e2e/browser.mjs <exe> <project-dir> <out-dir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { connect } from "./cdp.mjs";

const [exe, project, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9232", MUSHOKU_DEV_SEED_PROJECT: project, MUSHOKU_DEV_SEED_PROMPT: "Reply with the single word ok. Do not use any tools." }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 0;
const check = (n, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", n, extra);
  if (!ok) code = 1;
};
try {
  const c = await connect(9232);
  await c.waitFor("!!document.querySelector('canvas')", 30000);
  await c.click("Guild");
  await c.waitFor("document.body.innerText.includes('Claude in Chrome')", 20000);
  await sleep(2500);
  const card = () => c.evaluate("[...document.querySelectorAll('.card')].find(e=>e.innerText.includes('Use my browser in quests'))?.innerText ?? ''");
  let t = await card();
  console.log(t.replace(/\n+/g, " | ").slice(0, 420));
  check("browser card shows the official integration and its prerequisites", /Extension:/.test(t) && /--chrome/.test(t));
  check("browser support starts disabled (nothing silent)", /Off/.test(t));
  await c.evaluate("[...document.querySelectorAll('.card input[type=checkbox]')].find(i=>i.closest('.card').innerText.includes('Use my browser'))?.click()");
  await sleep(3000);
  t = await card();
  console.log(t.replace(/\n+/g, " | ").slice(0, 420));
  check("enabling shows a concrete state with guidance (not just a toggle)", /Ready|extension|Chrome|install/i.test(t) && !/Off\b/.test(t.split("Extension:")[0] ?? ""));
  await c.screenshot(`${out}/guild-browser.png`);
  await c.click("Quests");
  await c.click("Seeded test quest");
  await c.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Start Claude Code') && !b.disabled)", 90000);
  await c.click("Start Claude Code");
  const t0 = Date.now();
  let st = "";
  while (Date.now() - t0 < 120000) {
    if (await c.evaluate("!!document.querySelector('.dialog')")) await c.click("Allow once");
    st = await c.evaluate("document.querySelector('.task-head .pill')?.textContent ?? ''");
    if (/Completed|Failed|Cancelled/.test(st)) break;
    await sleep(400);
  }
  const feed = await c.evaluate("[...document.querySelectorAll('.ev')].map(e=>e.innerText.replace(/\\s+/g,' ')).join(' || ')");
  console.log(feed.slice(0, 600));
  check("quest completed", /Completed/.test(st), st);
  const ready = /extension found|Ready/.test(t) || (await card()).includes("Ready");
  if (ready) {
    check("Claude was started with the browser integration (activity note + connected server)", /Claude in Chrome is enabled/.test(feed) && /claude-in-chrome:connected/.test(feed));
  } else {
    check("without a usable extension the quest still ran normally and no browser flag was claimed", !/Claude in Chrome is enabled/.test(feed));
  }
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
