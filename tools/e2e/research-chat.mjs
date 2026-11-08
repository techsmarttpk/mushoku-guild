// Verifies Guild Chat end to end in the real app: Claude read-only research -> stored report -> ChatGPT answer.
//   node tools/e2e/research-chat.mjs <exe> <project-dir> <out-dir>
// Uses the seeded disposable project (debug build with --features dev-seed). The project should contain a decoy
// .env; the script fails if its secret value appears in the report, the activity feed or the chat answer.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { connect } from "./cdp.mjs";

const [exe, project, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const SECRET = process.env.E2E_SECRET ?? "supersecret-decoy-value-12345";
const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9229", MUSHOKU_DEV_SEED_PROJECT: project, MUSHOKU_DEV_SEED_PROMPT: "unused" }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 0;
try {
  const c = await connect(9229);
  await c.waitFor("!!document.querySelector('canvas')", 30000);
  await c.click("Chat");
  console.log("claude ready:", await c.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Ask Claude for Context') && !b.disabled)", 60000));
  console.log("initial status:", await c.evaluate("document.querySelector('.ctx-pill')?.innerText"));
  await c.click("Ask Claude for Context");
  await sleep(2500);
  console.log("during research:", await c.evaluate("document.querySelector('.ctx-pill')?.innerText"));
  await c.screenshot(`${out}/research-running.png`);
  const done = await c.waitFor("document.querySelector('.ctx-pill')?.innerText.includes('Context available')", 280000, 1000);
  console.log("research finished:", done, "| status:", await c.evaluate("document.querySelector('.ctx-pill')?.innerText"));
  const activity = await c.evaluate("[...document.querySelectorAll('.ev')].map(e=>e.innerText.replace(/\\s+/g,' ').slice(0,140)).join(' || ')");
  console.log("activity rows:", await c.evaluate("document.querySelectorAll('.ev').length"), "| tools used:", [...new Set((activity.match(/⚙ (\w+)/g) ?? []))].join(","));
  await c.click("Repository research");
  const report = await c.evaluate("document.querySelector('.research-box')?.innerText ?? ''");
  console.log("report length:", report.length, "| headings present:", ["Architecture", "Entry points", "Uncertainties"].map((h) => `${h}=${report.includes(h)}`).join(" "));
  console.log("report sample:", report.slice(0, 500).replace(/\s+/g, " "));
  await c.screenshot(`${out}/research-done.png`);
  // chat with ChatGPT, using the report as context
  await c.type("textarea", "Using the repository research, what does this project contain and what is the bug in math.js? Name the files you are relying on.");
  await c.click("Send");
  const answered = await c.waitFor("document.querySelectorAll('.msg-assistant').length>0 && !document.body.innerText.includes('is writing') && !document.body.innerText.includes('is thinking')", 120000, 500);
  const reply = await c.evaluate("[...document.querySelectorAll('.msg-assistant')].map(e=>e.innerText).join('\\n---\\n')");
  console.log("chat answered:", answered, "| reply sample:", reply.slice(0, 700).replace(/\s+/g, " "));
  const chatErr = await c.evaluate("document.querySelector('.note-error')?.innerText ?? ''");
  if (chatErr) console.log("chat error banner:", chatErr);
  await c.screenshot(`${out}/chat.png`);
  const leaked = [report, activity, reply].some((t) => t.includes(SECRET));
  console.log("decoy secret leaked anywhere:", leaked);
  if (leaked) code = 2;
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
