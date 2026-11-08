// End-to-end check of the Claude Code path against a DISPOSABLE project, driving the real debug app.
//   node tools/e2e/run-claude.mjs <exe> <project-dir> <out-dir> [allow|deny|cancel]
// The debug build seeds a project + an approved prompt (MUSHOKU_DEV_SEED_*); everything after that is the real
// app talking to the real `claude.exe`. Screenshots and a JSON transcript go to <out-dir>.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { connect } from "./cdp.mjs";

const [exe, project, out, mode = "allow"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const prompt =
  process.env.E2E_PROMPT ??
  "Fix the bug in math.js so that add(a, b) returns a + b. Then create a file notes.txt containing exactly the word done. Keep it brief.";
const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223", MUSHOKU_DEV_SEED_PROJECT: project, MUSHOKU_DEV_SEED_PROMPT: prompt },
  stdio: "ignore",
});
const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};
let code = 0;
try {
  const c = await connect(9223);
  await c.waitFor("!!document.querySelector('canvas')", 30000);
  await c.click("Log");
  await c.waitFor("[...document.querySelectorAll('.list-item')].some(e=>e.textContent.includes('Seeded'))", 10000);
  await c.click("Seeded test quest");
  say("claude ready: " + (await c.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Start Claude Code') && !b.disabled)", 90000)));
  await c.screenshot(`${out}/1-approved.png`);
  if (mode === "read_only") await c.click("Read-only");
  if (mode === "autopilot") await c.evaluate("document.querySelector('input[name=pmode]:nth-of-type(1)') && [...document.querySelectorAll('input[name=pmode]')][1].click()");
  if (mode === "autopilot") say("auto pilot chosen: " + (await c.evaluate("[...document.querySelectorAll('input[name=pmode]')][1].checked")));
  await c.click("Start Claude Code");
  await new Promise((r) => setTimeout(r, 1500));
  say("after start errors: " + JSON.stringify(c.errors.slice(0, 3)));
  const seenTools = new Set();
  const deadline = Date.now() + 240000;
  let decided = 0;
  while (Date.now() < deadline) {
    const dlg = await c.evaluate("(()=>{const d=document.querySelector('.dialog'); return d? d.innerText.slice(0,300):null})()");
    if (dlg) {
      say("PERMISSION DIALOG: " + dlg.replace(/\n+/g, " | "));
      if (decided === 0) await c.screenshot(`${out}/2-permission.png`);
      if (mode === "cancel") {
        await c.click("Allow once");
        say("allowed the long-running command, cancelling in 6 s");
        await new Promise((r) => setTimeout(r, 6000));
        break;
      }
      const choice = mode === "deny" ? "Deny" : "Allow once";
      decided++;
      await c.click(choice);
      say("clicked " + choice);
    }
    const st = await c.evaluate("document.querySelector('.pill')?.textContent ?? ''");
    if (/Completed|Failed|Cancelled|Accepted/.test(st)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (mode === "cancel") {
    await new Promise((r) => setTimeout(r, 500));
    await c.screenshot(`${out}/3-before-cancel.png`);
    await c.click("Cancel execution");
    await c.waitFor("/Cancelled/.test(document.querySelector('.pill')?.textContent ?? '')", 20000);
  }
  await new Promise((r) => setTimeout(r, 1200));
  await c.screenshot(`${out}/4-final.png`);
  say("STATUS: " + (await c.evaluate("document.querySelector('.pill')?.textContent")));
  say("ACTIVITY:\n" + (await c.evaluate("[...document.querySelectorAll('.ev')].map(e=>e.innerText.replace(/\\n+/g,' :: ').slice(0,200)).join('\\n')")));
  say("RESULT CARD: " + (await c.evaluate("document.querySelector('.result')?.innerText ?? ''")).slice(0, 500));
  say("PAGE ERRORS: " + JSON.stringify(c.errors.slice(0, 5)));
  c.close();
} catch (e) {
  say("E2E ERROR: " + e.message);
  code = 1;
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  fs.writeFileSync(`${out}/transcript.txt`, log.join("\n"));
}
process.exit(code);
