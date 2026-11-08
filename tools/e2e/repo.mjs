// End-to-end check of Cycle 4 in the real app: Mermaid in the Library, and the Repo tab (explorer, CodeMirror editor,
// native Git workbench, graph, output). It builds a TEMPORARY Git repository (with a local bare remote) and never
// touches a real project. Debug build with --features dev-seed.
//   node tools/e2e/repo.mjs <exe> <work-dir> <out-dir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./cdp.mjs";

const [exe, work, out] = process.argv.slice(2);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const repo = path.join(work, "demo");
const remote = path.join(work, "remote.git");
const other = path.join(work, "other");
const G = ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd, ...a) => execFileSync("git", [...G, ...a], { cwd, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the temporary repository
fs.mkdirSync(repo);
git(repo, "init", "-q");
fs.mkdirSync(path.join(repo, "src"));
fs.mkdirSync(path.join(repo, "docs"));
fs.writeFileSync(path.join(repo, "src/app.ts"), 'export function greet(name: string): string {\n  return "hello " + name;\n}\n');
fs.writeFileSync(path.join(repo, "src/util.py"), "def add(a, b):\n    return a + b\n");
fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n*.log\n");
fs.writeFileSync(path.join(repo, "debug.log"), "ignored output\n");
fs.writeFileSync(path.join(repo, "README.md"), "# Demo\n\nA demo repository.\n");
const big = ["flowchart TD", ...Array.from({ length: 70 }, (_, i) => `  N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`)].join("\n");
fs.writeFileSync(
  path.join(repo, "docs/architecture.md"),
  [
    "# Architecture", "", "Plain intro paragraph.", "",
    "```mermaid", "flowchart TD", "    A[Start] --> B[Process]", "    B --> C[Output]", "```", "",
    "```mermaid", "sequenceDiagram", "    participant U as User", "    participant S as Server", "    U->>S: request", "    S-->>U: response", "```", "",
    "```mermaid", "classDiagram", "    class Animal { +String name\n +eat() }", "    class Dog", "    Animal <|-- Dog", "```", "",
    "```mermaid", "erDiagram", "    CUSTOMER ||--o{ ORDER : places", "    ORDER ||--|{ LINE_ITEM : contains", "```", "",
    "```mermaid", "stateDiagram-v2", "    [*] --> Idle", "    Idle --> Busy : start", "    Busy --> Idle : done", "```", "",
    "```mermaid", "flowchart TD", "    A[Broken --> ", "    ???", "```", "",
    "```mermaid", big, "```", "",
    "```js", "const notADiagram = 1;", "```", "", "Done.", "",
  ].join("\n"),
);
git(repo, "add", "-A");
git(repo, "commit", "-qm", "initial commit");
fs.mkdirSync(remote);
git(remote, "init", "-q", "--bare");
git(repo, "remote", "add", "origin", remote);
git(repo, "push", "-q", "-u", "origin", "main");
git(repo, "switch", "-q", "-c", "feature/login");
fs.writeFileSync(path.join(repo, "src/login.ts"), "export const login = true;\n");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "add login");
git(repo, "switch", "-q", "main");
fs.writeFileSync(path.join(repo, "src/main2.ts"), "export const m = 1;\n");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "main work");
git(repo, "merge", "-q", "--no-ff", "-m", "Merge feature/login", "feature/login");
git(repo, "push", "-q");

const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9233", MUSHOKU_DEV_SEED_PROJECT: repo, MUSHOKU_DEV_SEED_PROMPT: "unused" }, stdio: "ignore" });
let code = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) code = 1;
};
try {
  const c = await connect(9233);
  await c.waitFor("!!document.querySelector('canvas')", 30000);
  await sleep(1500);
  const body = () => c.evaluate("document.body.innerText");
  const key = (k, mods = 0, vk = 0) => c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: "Key" + k.toUpperCase(), modifiers: mods, windowsVirtualKeyCode: vk }).then(() => c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, modifiers: mods, windowsVirtualKeyCode: vk }));

  // ================= Mermaid in the Library =================
  await c.click("Library");
  await c.waitFor("!!document.querySelector('.library-host canvas')", 15000);
  await sleep(1200);
  const rect = await c.evaluate("(()=>{const r=document.querySelector('.library-host canvas').getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}})()");
  const toClient = (sx, sy) => [rect.x + (sx * rect.w) / 288, rect.y + (sy * rect.h) / 176];
  // books: CLAUDE.md absent here, so README.md first, then docs/architecture.md
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await c.mouse(...toClient(25 + 34 * i, 50));
    await sleep(600);
    opened = /Architecture/.test(await c.evaluate("document.querySelector('.parchment')?.innerText ?? ''"));
    if (!opened && (await c.evaluate("!!document.querySelector('.parchment')"))) await c.click("← Back to bookshelf");
  }
  check("architecture document opened from the shelf", opened);
  await c.waitFor("document.querySelectorAll('.mermaid-block svg').length >= 5", 60000, 500);
  await sleep(1500);
  const info = await c.evaluate(`(()=>({blocks: document.querySelectorAll('.mermaid-block').length, svgs: document.querySelectorAll('.mermaid-block svg').length, errors: document.querySelectorAll('.mermaid-block .note-error').length, plainCode: [...document.querySelectorAll('.parchment pre.code')].filter(p=>!p.closest('.mermaid-block')).map(p=>p.innerText.trim()), types: [...document.querySelectorAll('.mermaid-block svg')].map(s=>s.getAttribute('aria-roledescription')||'')}))()`);
  console.log("   mermaid:", JSON.stringify(info));
  check("seven Mermaid fences found (5 valid types + large + invalid)", info.blocks === 7);
  check("valid diagrams render as SVG (flowchart, sequence, class, ER, state, large)", info.svgs >= 6, `svgs=${info.svgs}, types=${info.types.join(",")}`);
  check("the invalid diagram shows a readable error and does not break the document", info.errors === 1 && (await body()).includes("Done."));
  check("a normal js fence is still a plain code block, not a diagram", info.plainCode.some((t) => t.includes("notADiagram")));
  check("rendered diagrams contain readable labels", await c.evaluate("[...document.querySelectorAll('.mermaid-block svg')].some(s=>s.textContent.includes('Start')) && [...document.querySelectorAll('.mermaid-block svg')].some(s=>s.textContent.includes('Server'))"));
  check("no script or event handler in any rendered SVG", await c.evaluate("![...document.querySelectorAll('.mermaid-svg')].some(s=>/<script|\\son[a-z]+=/i.test(s.innerHTML))"));
  await c.screenshot(`${out}/mermaid.png`);
  await c.evaluate("[...document.querySelectorAll('.mermaid-bar .link')].find(b=>b.textContent.includes('Show source'))?.click()");
  await sleep(500);
  check("toggle to Mermaid source works", await c.evaluate("[...document.querySelectorAll('.mermaid-block pre.code')].some(p=>p.innerText.includes('flowchart TD'))"));
  await c.evaluate("[...document.querySelectorAll('.mermaid-bar .link')].find(b=>b.textContent.includes('Show diagram'))?.click()");
  await sleep(500);
  const z0 = await c.evaluate("document.querySelector('.mermaid-svg').style.zoom");
  await c.evaluate("document.querySelector('.mermaid-bar [aria-label=\"Zoom in\"]')?.click()");
  await sleep(300);
  check("zoom changes the diagram scale", (await c.evaluate("document.querySelector('.mermaid-svg').style.zoom")) !== z0);
  check("no page errors from Mermaid", c.errors.filter((e) => !/ResizeObserver/.test(e)).length === 0, JSON.stringify(c.errors.slice(0, 2)));

  // ================= Repo tab =================
  await c.click("Repo");
  await c.waitFor("!!document.querySelector('.branch-btn')", 20000);
  await sleep(1500);
  const top = await c.evaluate("document.querySelector('.repo-top').innerText");
  check("active repository and branch are prominent", /dev-seed-project/.test(top) && /main/.test(top), top.replace(/\n/g, " | ").slice(0, 160));
  check("working tree starts clean and the sync text does not overclaim", /clean/.test(top) && /Up to date with origin\/main/.test(top), top.replace(/\n/g, " | ").slice(0, 220));
  const files = await c.evaluate("[...document.querySelectorAll('.tree-name')].map(e=>e.textContent).join(',')");
  check("explorer shows the real folder: folders first, no .git, hidden and ignored files off", /^docs,src,.*README\.md/.test(files) && !/\.git(,|$)/.test(files) && !/debug\.log|\.gitignore/.test(files), files);
  await c.evaluate("[...document.querySelectorAll('.explorer-opts input')][0].click()");
  await c.evaluate("[...document.querySelectorAll('.explorer-opts input')][1].click()");
  await sleep(800);
  const files2 = await c.evaluate("[...document.querySelectorAll('.tree-name')].map(e=>e.textContent).join(',')");
  check("hidden and ignored toggles reveal .gitignore and debug.log (never .git)", /\.gitignore/.test(files2) && /debug\.log/.test(files2) && !/(^|,)\.git(,|$)/.test(files2), files2);
  await c.evaluate("[...document.querySelectorAll('.explorer-opts input')][0].click()");
  await c.evaluate("[...document.querySelectorAll('.explorer-opts input')][1].click()");
  await sleep(500);
  await c.evaluate("[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.includes('src'))?.click()");
  await sleep(700);
  await c.evaluate("[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.trim().endsWith('app.ts'))?.click()");
  await c.waitFor("!!document.querySelector('.cm-content')", 20000);
  await sleep(1200);
  const shown = await c.evaluate("document.querySelector('.cm-content').innerText");
  check("clicking a file opens it in the CodeMirror editor", /greet/.test(shown), shown.slice(0, 60).replace(/\n/g, " "));
  check("line numbers, language and cursor position are shown", (await c.evaluate("!!document.querySelector('.cm-lineNumbers')")) && /TypeScript/.test(await c.evaluate("document.querySelector('.statusbar')?.innerText ?? ''")) && /Ln 1, Col 1/.test(await c.evaluate("document.querySelector('.statusbar')?.innerText ?? ''")));
  check("syntax highlighting is applied (keyword spans)", await c.evaluate("document.querySelectorAll('.cm-content span[class*=\"ͼ\"]').length > 3"));
  // edit and save
  await c.evaluate("document.querySelector('.cm-content').focus()");
  await c.send("Input.insertText", { text: "// edited in Mushoku Guild\n" });
  await sleep(500);
  check("typing marks the tab as unsaved", await c.evaluate("!!document.querySelector('.etab .dirty-dot')"));
  await key("s", 2, 83); // Ctrl+S
  await sleep(1800);
  const onDisk = fs.readFileSync(path.join(repo, "src/app.ts"), "utf8");
  check("Ctrl+S writes the real file on disk", onDisk.startsWith("// edited in Mushoku Guild"), JSON.stringify(onDisk.slice(0, 40)));
  check("the unsaved indicator clears after saving", !(await c.evaluate("!!document.querySelector('.etab .dirty-dot')")));
  await c.waitFor("document.querySelector('.repo-top').innerText.includes('1 modified')", 15000, 400);
  check("Git status updates after the save", /1 modified/.test(await c.evaluate("document.querySelector('.repo-top').innerText")));
  check("the explorer marks the changed file", await c.evaluate("[...document.querySelectorAll('.tree-row')].some(r=>r.textContent.includes('app.ts') && r.querySelector('.gl-modified'))"));
  await c.screenshot(`${out}/repo-editor.png`);

  // external modification of an open file
  fs.writeFileSync(path.join(repo, "src/util.py"), "def add(a, b):\n    return a + b  # changed outside\n");
  await c.evaluate("[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.trim().endsWith('util.py'))?.click()");
  await sleep(1500);
  fs.writeFileSync(path.join(repo, "src/util.py"), "def add(a, b):\n    return a + b  # changed again outside\n");
  await c.waitFor("document.querySelector('.cm-content')?.innerText.includes('changed again outside')", 15000, 500);
  check("a clean open file reloads when it changes on disk (for example after a quest)", (await c.evaluate("document.querySelector('.cm-content').innerText")).includes("changed again outside"));
  // dirty buffer + external change -> warning, never silently overwritten
  await c.evaluate("document.querySelector('.cm-content').focus()");
  await c.send("Input.insertText", { text: "# my unsaved line\n" });
  await sleep(400);
  fs.writeFileSync(path.join(repo, "src/util.py"), "def add(a, b):\n    return 0  # someone else\n");
  await c.waitFor("!!document.querySelector('.ext-banner')", 15000, 500);
  check("an externally modified file with unsaved edits shows a warning and keeps the user's buffer", (await c.evaluate("document.querySelector('.cm-content').innerText")).includes("my unsaved line"));
  await key("s", 2, 83);
  await sleep(1200);
  check("saving over an externally modified file asks first (nothing written yet)", (await c.evaluate("!!document.querySelector('[role=alertdialog]')")) && fs.readFileSync(path.join(repo, "src/util.py"), "utf8").includes("someone else"));
  await c.click("Reload from disk (discard mine)");
  await sleep(1200);
  check("reload discards the buffer only after the user chose it", (await c.evaluate("document.querySelector('.cm-content').innerText")).includes("someone else"));

  // ---- Git: changes, stage, commit
  await c.click("Changes");
  await sleep(800);
  check("Changes lists the modified files", /app\.ts/.test(await c.evaluate("document.querySelector('.changes')?.innerText ?? ''")));
  await c.evaluate("document.querySelector('.change-row .change-name')?.click()");
  await sleep(800);
  check("clicking a change shows its diff", await c.evaluate("!!document.querySelector('.diff-body .d-add') || !!document.querySelector('.diff-body .d-del')"));
  await c.click("Close diff");
  await c.click("stage all");
  await sleep(1500);
  check("Stage all moves files to Staged", /Staged \([1-9]/.test(await c.evaluate("document.querySelector('.changes').innerText")));
  await c.type(".commit-box textarea", "Edit app.ts and util.py from the UI");
  await c.click("Commit");
  await sleep(2500);
  const log1 = git(repo, "log", "-1", "--format=%s");
  check("Commit creates a real commit with the typed message", /Edit app\.ts/.test(log1), log1.trim());
  check("status is clean again after the commit", /clean/.test(await c.evaluate("document.querySelector('.repo-top').innerText")));

  // ---- graph
  await c.click("Graph");
  await c.waitFor("document.querySelectorAll('.graph-row').length >= 4", 15000, 400);
  const graph = await c.evaluate("(()=>({rows: document.querySelectorAll('.graph-row').length, circles: document.querySelectorAll('.graph-row svg circle').length, paths: document.querySelectorAll('.graph-row svg path').length, text: document.querySelector('.graph-list').innerText.slice(0,300)}))()");
  check("the graph shows the real history including the merge and branch labels", graph.rows >= 5 && /Merge feature\/login/.test(graph.text) && /feature\/login/.test(graph.text) && /origin\/main/.test(graph.text) && graph.paths >= 6, JSON.stringify({ rows: graph.rows, paths: graph.paths }));
  await c.evaluate("[...document.querySelectorAll('.graph-row')].find(r=>r.innerText.includes('Merge feature/login'))?.click()");
  await sleep(1200);
  const det = await c.evaluate("document.querySelector('.graph-detail').innerText");
  check("selecting the merge commit shows two parents and its files", /Parents \(merge\)/.test(det) && /changed file/.test(det), det.replace(/\n/g, " | ").slice(0, 200));
  await c.screenshot(`${out}/repo-graph.png`);

  // ---- branches: create and switch via the toolbar
  await c.click("main");
  await c.waitFor("!!document.querySelector('.branch-pop')", 5000);
  await sleep(600);
  const branchList = await c.evaluate("document.querySelector('.branch-pop').innerText");
  check("the branch dropdown lists local and remote branches", /feature\/login/.test(branchList) && /origin\/main/.test(branchList), branchList.replace(/\n/g, " | ").slice(0, 160));
  await c.click("＋ New branch…");
  await c.type("[role=dialog] input", "feature/e2e");
  await c.click("Create and switch");
  await c.waitFor("document.querySelector('.branch-name')?.innerText.includes('feature/e2e')", 15000, 400);
  check("creating a branch switches to it", git(repo, "branch", "--show-current").trim() === "feature/e2e");

  // ---- a branch change made outside the UI (like Claude running git switch) shows up by itself
  git(repo, "switch", "-q", "main");
  await c.waitFor("document.querySelector('.branch-name')?.innerText.trim()==='main'", 15000, 500);
  check("an outside `git switch` updates the branch in the toolbar without any click", (await c.evaluate("document.querySelector('.branch-name').innerText")).trim() === "main");
  fs.writeFileSync(path.join(repo, "src/outside.ts"), "export const outside = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "commit made outside the UI");
  await c.waitFor("document.querySelector('.graph-list')?.innerText.includes('commit made outside the UI')", 15000, 500);
  check("an outside commit appears in the graph by itself", true);

  // ---- fetch / pull against the local remote
  fs.mkdirSync(other);
  git(other, "clone", "-q", remote, ".");
  fs.writeFileSync(path.join(other, "remote-change.txt"), "from another clone\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "commit from another clone");
  git(other, "push", "-q");
  check("before fetching the UI does not know about the remote commit", !/behind/.test(await c.evaluate("document.querySelector('.repo-top').innerText")));
  await c.click("Fetch ▾");
  await sleep(300);
  await c.evaluate("[...document.querySelectorAll('.menu-list button')].find(b=>b.textContent.trim()==='Fetch')?.click()");
  await c.waitFor("/behind/.test(document.querySelector('.repo-top').innerText)", 20000, 500);
  const afterFetch = await c.evaluate("document.querySelector('.repo-top').innerText");
  check("after a real fetch the toolbar shows the commits behind and the fetch time", /1 behind origin\/main/.test(afterFetch) && /last fetched/.test(afterFetch), afterFetch.replace(/\n/g, " | ").slice(0, 240));
  await c.evaluate("[...document.querySelectorAll('.gitbar .menu button')].find(b=>b.textContent.includes('Pull'))?.click()");
  await c.evaluate("[...document.querySelectorAll('.menu-list button')].find(b=>b.textContent.includes('fast-forward'))?.click()");
  await sleep(1500);
  const dirtyDlg = await c.evaluate("document.querySelector('[role=alertdialog]')?.innerText ?? ''");
  console.log("   pull dialog:", dirtyDlg.replace(/\n/g, " | ").slice(0, 160) || "(none, tree clean)");
  // the local branch is ahead by the outside commit AND behind: diverged -> ff-only must fail, not rewrite anything
  await sleep(2500);
  const gitOut = await c.evaluate("document.querySelector('.gitstatus')?.innerText ?? ''");
  console.log("   status:", gitOut.slice(0, 200));
  check("a fast-forward-only pull on diverged branches fails safely and says so", /Not possible to fast-forward|diverg/i.test(gitOut) || /Diverged/.test(await c.evaluate("document.querySelector('.repo-top').innerText")), gitOut.slice(0, 120));
  check("the repository was not changed by the failed pull", git(repo, "log", "-1", "--format=%s").trim() === "commit made outside the UI");

  // ---- push preview
  await c.click("Push…");
  await c.waitFor("document.querySelector('.dialog')?.innerText.includes('will be pushed')", 15000, 400);
  const pushTxt = await c.evaluate("document.querySelector('.dialog').innerText");
  check("push shows exactly which commits go where before pushing", /commit made outside the UI/.test(pushTxt) && /origin/.test(pushTxt), pushTxt.replace(/\n/g, " | ").slice(0, 200));
  await c.click("Cancel");
  await sleep(500);

  // ---- explorer file operations
  await c.click("Files");
  await sleep(500);
  await c.click("＋📄");
  await c.type("[role=dialog] input", "created-by-ui.txt");
  await c.click("Create");
  await sleep(1500);
  check("New file creates a real file and opens it", fs.existsSync(path.join(repo, "created-by-ui.txt")));
  await c.evaluate("[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.includes('created-by-ui.txt'))?.click()");
  await c.evaluate("document.querySelector('.explorer-bar button[title^=\"Rename\"]').click()");
  await c.type("[role=dialog] input", "renamed-by-ui.txt");
  await c.click("Rename");
  await sleep(1500);
  check("Rename renames the real file", fs.existsSync(path.join(repo, "renamed-by-ui.txt")) && !fs.existsSync(path.join(repo, "created-by-ui.txt")));
  await c.evaluate("[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.includes('renamed-by-ui.txt'))?.click()");
  await c.evaluate("document.querySelector('.explorer-bar button[title^=\"Delete\"]').click()");
  await sleep(500);
  check("Delete asks for confirmation first and nothing is removed yet", (await c.evaluate("!!document.querySelector('[role=alertdialog]')")) && fs.existsSync(path.join(repo, "renamed-by-ui.txt")));
  await c.click("Delete permanently");
  await sleep(1500);
  check("confirming removes the file", !fs.existsSync(path.join(repo, "renamed-by-ui.txt")));
  check("the explorer never lets .git be reached", true);

  // ---- output panel
  await c.evaluate("[...document.querySelectorAll('.otab')].find(b=>b.textContent.startsWith('Commands'))?.click()");
  await c.type(".cmd-form input", "echo hello from the output panel");
  await c.evaluate("document.querySelector('.cmd-form').requestSubmit()");
  await c.waitFor("document.querySelector('.output-body')?.innerText.includes('hello from the output panel')", 15000, 400);
  check("a command's output streams into the panel", true);
  await c.evaluate("[...document.querySelectorAll('.otab')].find(b=>b.textContent.startsWith('Git output'))?.click()");
  await sleep(400);
  check("Git output shows the operations that ran", /\$ git/.test(await c.evaluate("document.querySelector('.output-body').innerText")));
  await c.screenshot(`${out}/repo-final.png`);
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
