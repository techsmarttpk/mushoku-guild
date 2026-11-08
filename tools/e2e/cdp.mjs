// Minimal Chrome DevTools Protocol client for driving the real app's WebView2 during verification.
// Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>. No dependencies
// (Node >= 22 has a global WebSocket). Used only for local testing; the shipped app does not enable this.
import fs from "node:fs";

export async function connect(port = 9222, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!target) throw new Error("no WebView2 debug target found");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const screenshot = async (file) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
    return file;
  };
  /** Clicks the first element (button/tab) whose visible text includes `text`. */
  const click = (text) =>
    evaluate(`(() => { const els=[...document.querySelectorAll('button,[role=tab],summary')]; const el=els.find(e=>e.textContent.includes(${JSON.stringify(text)}) && !e.disabled); if(!el) return false; el.click(); return true; })()`);
  const waitFor = async (expression, ms = 30000, step = 250) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, step));
    }
    return false;
  };
  const type = (selector, value) =>
    evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await send("Runtime.enable");
  return { errors, send, evaluate, screenshot, click, waitFor, type, close: () => ws.close() };
}
