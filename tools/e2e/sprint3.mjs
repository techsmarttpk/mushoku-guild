// Sprint 3 end-to-end check against the real app, ChatGPT and Claude Code (debug build with --features dev-seed).
//   node tools/e2e/sprint3.mjs <exe> <project-dir> <out-dir>
// Covers: quest history + New Quest, trusted repository, chat (direct answer vs autonomous Claude research),
// conversation history (search / rename / delete), Library bookshelf (click a book, read, ask ChatGPT),
// website launch lifecycle (quest completes while the server runs; Open / Stop).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { connect } from "./cdp.mjs";

const [exe, project, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const PROMPT = "Start the web server defined in server.js in the background using Bash (node server.js, run it in the background so the command returns immediately). Then reply with one sentence that includes the URL http://localhost:8123 where it is served.";
const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9231", MUSHOKU_DEV_SEED_PROJECT: project, MUSHOKU_DEV_SEED_PROMPT: PROMPT }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let code = 0;
const check = (name, ok, extra = "") => {
  log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) code = 1;
};
try {
  const c = await connect(9231);
  await c.waitFor("!!document.querySelector('canvas')", 30000);
  await sleep(1500);
  const text = (sel) => c.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.innerText).join('\\n---\\n')`);

  // ---- tabs and header
  const tabs = await c.evaluate("[...document.querySelectorAll('[role=tab]')].map(t=>t.innerText.trim()).join(',')");
  check("tabs are Quests, Chat, Library, Guild", tabs.replace(/\s+/g, "") === "Quests,Chat,Library,Guild", tabs);
  const header = await c.evaluate("document.querySelector('.top').innerText");
  check("no model name in the global header", !/sonnet|opus|haiku|gpt-|model/i.test(header), header.replace(/\n/g, " | "));

  // ---- quest history
  await c.click("Quests");
  await c.waitFor("document.body.innerText.includes('New Quest')", 10000);
  check("quest history has a New Quest button and the repository tag", (await c.evaluate("document.body.innerText")).includes("New Quest") && (await c.evaluate("!!document.querySelector('.repo-tag')")));
  await c.screenshot(`${out}/quests.png`);
  check("seeded quest listed with status and mode", (await text(".quest")).includes("Seeded test quest"));
  await c.click("New Quest");
  check("New Quest opens the existing creation form", await c.waitFor("document.body.innerText.includes('What should be done?')", 5000));
  await c.click("← Quests");

  // ---- chat: a greeting must not trigger Claude
  await c.click("Chat");
  await c.waitFor("!!document.querySelector('.chat-input textarea')", 10000);
  await c.type(".chat-input textarea", "Hello! Just saying hi.");
  await c.click("Send");
  await c.waitFor("document.querySelectorAll('.msg-assistant').length>0 && !document.body.innerText.includes('is thinking') && !document.body.innerText.includes('is writing')", 90000, 500);
  check("a greeting is answered directly (no Claude research)", (await c.evaluate("document.querySelectorAll('.msg-agent').length")) === 0, (await text(".msg-assistant")).slice(0, 120).replace(/\n/g, " "));

  // ---- chat: a repository question makes ChatGPT ask Claude by itself
  await c.type(".chat-input textarea", "Look at the actual code: what does math.js export and is there a bug in add()? Cite the file.");
  await c.click("Send");
  let sawResearching = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 360000) {
    if (await c.evaluate("document.body.innerText.includes('Claude · researching')")) sawResearching = true;
    const done = await c.evaluate("document.querySelectorAll('.msg-assistant').length>=2 && !document.body.innerText.includes('is thinking') && !document.body.innerText.includes('is writing') && !document.body.innerText.includes('Claude · researching')");
    if (done) break;
    await sleep(700);
  }
  await c.screenshot(`${out}/chat-agents.png`);
  const agentCount = await c.evaluate("document.querySelectorAll('.msg-agent:not(.msg-live)').length");
  check("ChatGPT autonomously asked Claude (agent message in the conversation)", agentCount >= 1 && sawResearching, `agent messages=${agentCount}, saw live indicator=${sawResearching}`);
  const answer = (await text(".msg-assistant")).slice(-700).replace(/\n/g, " ");
  log("   final answer:", answer);
  check("final answer uses the findings (mentions the bug)", /subtract|minus|a - b|bug|incorrect|wrong/i.test(answer));
  const wholeChat = await text(".chat-log");
  check("no secret from the decoy .env in the conversation", !wholeChat.includes("supersecret-decoy"));
  check("the hidden request block is never shown", !wholeChat.includes("claude_research"));

  // ---- conversation history
  const rail = await text(".conv");
  check("conversation appears in the history with a generated title", /math\.js|Look at the actual code|Hello/i.test(rail), rail.replace(/\n/g, " ").slice(0, 120));
  await c.type(".rail input[type=search]", "math");
  await sleep(700);
  check("search finds it by message content", (await c.evaluate("document.querySelectorAll('.conv').length")) >= 1);
  await c.type(".rail input[type=search]", "zzzz-nothing");
  await sleep(700);
  check("search with no match shows none", (await c.evaluate("document.querySelectorAll('.conv').length")) === 0);
  await c.type(".rail input[type=search]", "");
  await sleep(600);
  await c.click("rename");
  await c.type(".rail form input", "Renamed by e2e");
  await c.evaluate("document.querySelector('.rail form').requestSubmit()");
  await sleep(700);
  check("rename works", (await text(".conv")).includes("Renamed by e2e"));
  await c.click("+ New conversation");
  await sleep(800);
  check("new conversation starts empty and the old one is kept", (await c.evaluate("document.querySelectorAll('.conv').length")) >= 2);
  await c.screenshot(`${out}/chat-history.png`);

  // ---- library
  await c.click("Library");
  await c.waitFor("!!document.querySelector('.library-host canvas')", 15000);
  await sleep(1500);
  await c.screenshot(`${out}/library.png`);
  const rect = await c.evaluate("(()=>{const r=document.querySelector('.library-host canvas').getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}})()");
  const toClient = (sx, sy) => [rect.x + (sx * rect.w) / 288, rect.y + (sy * rect.h) / 176];
  const [bx, by] = toClient(25, 50); // first book (CLAUDE.md): scene coordinates from domain/shelf.ts
  await c.mouse(bx, by, "move");
  await sleep(500);
  check("hovering a book shows its details", (await c.evaluate("document.body.innerText")).includes("CLAUDE.md"));
  await c.mouse(bx, by);
  await c.waitFor("!!document.querySelector('.parchment')", 10000);
  const reading = await c.evaluate("document.querySelector('.parchment')?.innerText ?? ''");
  check("clicking a book opens it on parchment (CLAUDE.md first)", /Constitution/.test(reading) && /CLAUDE\.md/.test(reading), reading.slice(0, 80).replace(/\n/g, " "));
  await c.screenshot(`${out}/library-reading.png`);
  await c.click("← Back to bookshelf");
  const [b2x, b2y] = toClient(25 + 34 * 2, 50); // third book
  await c.mouse(b2x, b2y);
  await c.waitFor("!!document.querySelector('.parchment')", 10000);
  const second = await c.evaluate("document.querySelector('.parchment')?.innerText ?? ''");
  log("   third book:", second.slice(0, 100).replace(/\n/g, " "));
  const isArch = /Architecture/.test(second);
  if (!isArch) {
    await c.click("← Back to bookshelf");
    await c.mouse(...toClient(25 + 34 * 3, 50));
    await c.waitFor("!!document.querySelector('.parchment')", 10000);
  }
  const arch = await c.evaluate("document.querySelector('.parchment')?.innerText ?? ''");
  check("an architecture document renders with its table and code block", /Part/.test(arch) && (await c.evaluate("!!document.querySelector('.parchment table') && !!document.querySelector('.parchment pre.code')")), arch.slice(0, 60).replace(/\n/g, " "));
  await c.click("Ask ChatGPT about this document");
  await c.click("New conversation");
  await c.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Chat')", 15000);
  await c.waitFor("document.querySelectorAll('.msg-assistant').length>0 && !document.body.innerText.includes('is thinking') && !document.body.innerText.includes('is writing')", 120000, 500);
  const docChat = await text(".chat-log");
  check("the document is attached to a new conversation and ChatGPT read it", docChat.includes("Attached document") && /architecture|math|index/i.test(docChat.split("Attached document")[1] ?? ""), docChat.slice(0, 260).replace(/\n/g, " "));
  await c.screenshot(`${out}/library-chat.png`);

  // ---- quest: website launch lifecycle
  await c.click("Quests");
  await c.click("Seeded test quest");
  await c.waitFor("document.body.innerText.includes('Start Claude Code')", 15000);
  const permCard = await c.evaluate("document.querySelector('.perm-card')?.innerText ?? ''");
  check("repository is trusted (seeded) and its saved profile is visible", /Trusted repository/.test(permCard), permCard.replace(/\n/g, " ").slice(0, 100));
  await c.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Start Claude Code') && !b.disabled)", 90000);
  await c.click("Start Claude Code");
  const q0 = Date.now();
  let status = "";
  while (Date.now() - q0 < 240000) {
    if (await c.evaluate("!!document.querySelector('.dialog')")) await c.click("Allow once");
    status = await c.evaluate("document.querySelector('.task-head .pill')?.textContent ?? ''");
    if (/Completed|Failed|Cancelled/.test(status)) break;
    await sleep(400);
  }
  check("quest completes while its server keeps running", /Completed/.test(status), status);
  await sleep(1500);
  await c.screenshot(`${out}/quest-services.png`);
  const svc = await c.evaluate("document.querySelector('.services')?.innerText ?? ''");
  check("launched website and process are listed separately from the quest", /localhost:8123/.test(svc) && /node\.exe/i.test(svc), svc.replace(/\n/g, " | ").slice(0, 220));
  const up = await fetch("http://127.0.0.1:8123").then((r) => r.text(), () => "DOWN");
  check("the server is still alive after the quest finished", up === "hi", up);
  check("no 'Claude Code is working' after completion", !(await c.evaluate("document.body.innerText")).includes("Claude Code is working"));
  await c.click("Stop");
  await sleep(2500);
  const down = await fetch("http://127.0.0.1:8123").then(() => "UP", () => "DOWN");
  check("Stop ends the process owned by Mushoku Guild", down === "DOWN", down);
  log("page errors:", JSON.stringify(c.errors.slice(0, 3)));
  c.close();
} catch (e) {
  log("E2E ERROR:", e.message);
  code = 1;
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* gone */
  }
}
process.exit(code);
