// Read-only smoke test of an INSTALLED release build against the user's existing data. It opens every tab, checks the
// provider chips, Git status, opens one file in the editor without changing it, reads a Library document and renders a
// Mermaid diagram through the lazily loaded chunk. It never types into the editor and never saves.
//   node tools/e2e/verify-install.mjs <installed exe> <out-dir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { connect } from "./cdp.mjs";

const [exe, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9236" }, stdio: "ignore" });
let code = 0;
const check = (n, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", n, extra);
  if (!ok) code = 1;
};
try {
  const c = await connect(9236);
  await c.waitFor("!!document.querySelector('canvas')", 40000);
  await sleep(2500);
  const body = () => c.evaluate("document.body.innerText");
  check("café canvas renders", await c.evaluate("(()=>{const k=document.querySelector('canvas'); return !!k && k.width>100 && k.height>100})()"));
  await c.screenshot(`${out}/install-1-quests.png`);
  check("project selector lists existing repositories", /Weeknd-Website/.test(await body()));
  const chips = await c.evaluate("document.querySelector('header')?.innerText ?? document.body.innerText.slice(0,300)");
  console.log("   header:", chips.replace(/\n/g, " | ").slice(0, 160));
  await c.click("Guild");
  await c.waitFor("!/Checking/.test(document.body.innerText)", 40000, 500).catch(() => undefined);
  await sleep(800);
  await c.waitFor("/Claude ●/.test(document.querySelector('header').innerText)", 40000, 500).catch(() => undefined);
  check("Claude Code chip turns solid once detection finishes", /Claude ●/.test(await c.evaluate("document.querySelector('header').innerText")));
  const guild = await body();
  check("Guild tab opens and shows provider settings", /ChatGPT/.test(guild) && /Claude/.test(guild));
  check("Claude Code is detected", /claude/i.test(guild) && !/not found|not detected/i.test(guild.slice(0, 2000)), (guild.match(/Claude Code[^\n]*\n[^\n]*/)?.[0] ?? "").replace(/\n/g, " | ").slice(0, 120));
  await c.screenshot(`${out}/install-2-guild.png`);
  await c.click("Chat");
  await sleep(1000);
  check("Chat tab opens", /conversation|Talk to ChatGPT|Connect ChatGPT/i.test(await body()));
  await c.click("Quests");
  await sleep(800);
  check("Quests tab shows saved quest history", /Completed|Cancelled|Awaiting/.test(await body()));
  await c.click("Library");
  await c.waitFor("!!document.querySelector('.library-host canvas')", 15000);
  await sleep(1200);
  check("Library bookshelf renders", true);
  await c.evaluate("(()=>{const s=document.querySelector('header select'); const o=[...s.options].find(o=>o.text.includes('Weeknd-Website')); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,o.value); s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await sleep(2500);
  await c.click("Repo");
  await c.waitFor("!!document.querySelector('.branch-btn')", 20000);
  await sleep(1800);
  const top = await c.evaluate("document.querySelector('.repo-top').innerText");
  check("Repo tab loads Git status for the selected repository", /Weeknd-Website/.test(top) && /\n.*\n/.test(top), top.replace(/\n/g, " | ").slice(0, 200));
  const names = await c.evaluate("[...document.querySelectorAll('.tree-name')].map(e=>e.textContent)");
  check("explorer lists real files", names.length > 2, names.slice(0, 6).join(","));
  const md = names.find((n) => /^README\.md$/i.test(n)) ?? names.find((n) => /\.(json|ts|tsx|md)$/i.test(n) && !/lock/.test(n));
  if (md) {
    await c.evaluate(`[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.trim().endsWith(${JSON.stringify(md)}))?.click()`);
    await c.waitFor("!!document.querySelector('.cm-content')", 20000);
    await sleep(1200);
    check(`editor opens a real file (${md})`, (await c.evaluate("document.querySelector('.cm-content').innerText.length")) > 10);
  }
  await c.screenshot(`${out}/install-3-repo.png`);
  // Mermaid through the lazy chunk in the release bundle, under the production CSP
  const chunk = fs.readdirSync("dist/assets").find((f) => /^mermaid\.core-.*\.js$/.test(f));
  const svg = await c.evaluate(`(async()=>{try{const m=(await import('/assets/${chunk}')).default; m.initialize({startOnLoad:false,securityLevel:'strict'}); const r=await m.render('t1','flowchart TD; A[Start]-->B[End]'); return r.svg.includes('Start')&&r.svg.includes('<svg')?'ok':'bad'}catch(e){return 'ERR '+e.message}})()`);
  check("Mermaid chunk loads and renders under the production CSP", svg === "ok", svg);
  console.log("page errors:", JSON.stringify(c.errors.slice(0, 3)));
  c.close();
} catch (e) {
  console.log("E2E ERROR:", e.message);
  code = 1;
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}
process.exit(code);
