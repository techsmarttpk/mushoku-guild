// THROWAWAY Phase 1 experiment. Not production code. Zero dependencies (Node >= 20 built-ins only).
// Follows only the official docs under https://developers.openai.com/siwc/token-sharing-open-source
//
// Safety properties (by construction):
//  - Authentication happens in YOUR browser on auth.openai.com; this script never sees a password.
//  - Tokens live only in process memory. Nothing is written to disk. Tokens are never printed.
//  - No API key, no cookies, no ChatGPT website automation, no backend-api endpoints.
//
// Run:  node spikes/chatgpt-siwc/spike.mjs
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const APP_NAME = "Mushoku Guild"; // agent_name_hint (display metadata, user can edit)
const PORT = Number(process.env.SPIKE_PORT || 1455);
const REDIRECT = `http://127.0.0.1:${PORT}/auth/callback`;
const WAIT_MS = 5 * 60 * 1000;

const result = { auth: "not run", scope: "not run", models: "not run", inference: "not run", notes: [] };
const secrets = new Set(); // exact token strings, for redaction
const b64u = (b) => Buffer.from(b).toString("base64url");
const enc = encodeURIComponent;

function redact(s) {
  let out = String(s);
  for (const t of secrets) if (t) out = out.split(t).join("[REDACTED]");
  return out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]");
}
const log = (...a) => console.log(redact(a.join(" ")));
const mask = (e) => (e ? e.replace(/^(.).*(@.*)$/, "$1***$2") : "(none)");

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url")), payload: JSON.parse(Buffer.from(p, "base64url")), signing: `${h}.${p}`, sig: Buffer.from(s, "base64url") };
}

function openBrowser(url) {
  // rundll32 avoids shell-quoting problems with '&' in the URL (Windows); other OSes use their opener.
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* user can paste the URL */ }
}

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== "/auth/callback") { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": "text/html" }).end("<h3>Mushoku Guild spike: you can close this tab and return to the terminal.</h3>");
      server.close();
      clearTimeout(timer);
      const q = u.searchParams;
      log("callback parameters received:", [...q.keys()].join(", "));
      if (q.get("state") !== expectedState) return reject(new Error("state mismatch - rejecting callback"));
      if (q.get("error")) return reject(new Error(`authorization error: ${q.get("error")} ${q.get("error_description") || ""}`));
      resolve({ code: q.get("code"), clientId: q.get("client_id"), scope: q.get("scope") });
    });
    const timer = setTimeout(() => { server.close(); reject(new Error("timed out waiting for browser sign-in")); }, WAIT_MS);
    server.on("error", (e) => reject(new Error(`cannot listen on 127.0.0.1:${PORT}: ${e.message} (set SPIKE_PORT)`)));
    server.listen(PORT, "127.0.0.1");
  });
}

async function verifyIdToken(idToken, clientId, nonce) {
  const jwt = decodeJwt(idToken);
  const disco = await (await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(30000) })).json();
  const jwks = await (await fetch(disco.jwks_uri, { signal: AbortSignal.timeout(30000) })).json();
  const jwk = jwks.keys.find((k) => k.kid === jwt.header.kid) || (jwks.keys.length === 1 ? jwks.keys[0] : null);
  if (!jwk) throw new Error(`no JWKS key for kid ${jwt.header.kid}`);
  if (jwt.header.alg !== "RS256") throw new Error(`unsupported ID token alg ${jwt.header.alg} (spike verifies RS256 only)`);
  const ok = crypto.verify("RSA-SHA256", Buffer.from(jwt.signing), crypto.createPublicKey({ key: jwk, format: "jwk" }), jwt.sig);
  const c = jwt.payload;
  const aud = [].concat(c.aud);
  const checks = {
    signature: ok,
    issuer: c.iss === ISSUER,
    audience: aud.includes(clientId),
    notExpired: c.exp * 1000 > Date.now(),
    nonce: c.nonce === nonce,
  };
  return { checks, claims: c, revocation_endpoint: disco.revocation_endpoint };
}

// Print non-secret descriptive claims (names always; values only for plan/scope-like fields).
function describeClaims(label, claims) {
  const out = [];
  out.push(`${label} claim names: ${Object.keys(claims).join(", ")}`);
  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    out.push(`${label} openai/auth keys: ${Object.keys(auth).join(", ")}`);
    for (const [k, v] of Object.entries(auth)) if (/plan|tier|type|sub/i.test(k) && typeof v !== "object" && !/user_id|account_id/i.test(k)) out.push(`  ${k} = ${v}`);
  }
  if (claims.scope || claims.scp) out.push(`${label} scope = ${[].concat(claims.scope || claims.scp).join(" ")}`);
  out.forEach((l) => log(l));
}

async function main() {
  log("=== Mushoku Guild Sign in with ChatGPT spike (throwaway) ===");
  const hostId = `urn:uuid:${crypto.randomUUID()}`; // in-memory only; opaque, not a credential
  const state = b64u(crypto.randomBytes(24));
  const nonce = b64u(crypto.randomBytes(24));
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());

  const params = {
    client_id: "dynamic_agent_client", agent_name_hint: APP_NAME, ext_agent_host_id: hostId,
    response_type: "code", redirect_uri: REDIRECT, scope: SCOPE, resource: RESOURCE,
    state, nonce, code_challenge_method: "S256", code_challenge: challenge,
  };
  const url = `${AUTHORIZE}?` + Object.entries(params).map(([k, v]) => `${k}=${enc(v)}`).join("&");

  const pending = waitForCallback(state); // listener started BEFORE opening the browser
  await new Promise((r) => setTimeout(r, 300));
  log("\nOpening your browser to sign in. If it does not open, paste this URL into a browser:\n" + url + "\n");
  openBrowser(url);
  log("Waiting up to 5 minutes for you to complete sign-in and consent in the browser...");

  let cb;
  try { cb = await pending; } catch (e) { result.auth = `FAILED at authorization: ${e.message}`; return; }
  if (!cb.code) { result.auth = "FAILED: callback had no code"; return; }
  if (!cb.clientId || cb.clientId === "dynamic_agent_client") { result.auth = "FAILED: no issued client_id in callback (registration incomplete)"; return; }
  log("issued client_id prefix:", cb.clientId.slice(0, 6) + "...", "| callback scope:", cb.scope || "(none)");

  // ---- token exchange
  const tr = await fetch(TOKEN, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(60000),
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: cb.clientId, code: cb.code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE }),
  });
  const tbody = await tr.text();
  if (!tr.ok) { result.auth = `FAILED token exchange: HTTP ${tr.status} ${redact(tbody).slice(0, 400)}`; return; }
  const tok = JSON.parse(tbody);
  [tok.access_token, tok.refresh_token, tok.id_token].forEach((t) => t && secrets.add(t));
  log("token response fields:", Object.keys(tok).join(", "), `| token_type=${tok.token_type} expires_in=${tok.expires_in}`);
  log("token response scope:", tok.scope);

  // ---- ID token validation
  try {
    const v = await verifyIdToken(tok.id_token, cb.clientId, nonce);
    log("ID token checks:", JSON.stringify(v.checks), "| email:", mask(v.claims.email));
    describeClaims("id_token", v.claims);
    if (!Object.values(v.checks).every(Boolean)) { result.auth = "FAILED: ID token validation failed " + JSON.stringify(v.checks); return; }
    result.auth = "OK (code exchanged, ID token signature/iss/aud/exp/nonce verified)";
  } catch (e) { result.auth = `FAILED ID token validation: ${e.message}`; return; }
  try { describeClaims("access_token", decodeJwt(tok.access_token).payload); } catch { log("access_token is not a decodable JWT (opaque); skipping claim inspection"); }

  // ---- scope / plan-usage permission
  const granted = String(tok.scope || "").split(/\s+/);
  if (!granted.includes("chatgpt.tokens.use.direct")) {
    result.scope = `NOT GRANTED: chatgpt.tokens.use.direct missing (granted: ${granted.join(" ")}). ChatGPT plan usage is not enabled for this account/consent.`;
    return;
  }
  result.scope = "OK (chatgpt.tokens.use.direct granted)";

  const authz = { authorization: `Bearer ${tok.access_token}` };

  // ---- model discovery
  const mr = await fetch(`${RESOURCE}/models`, { headers: authz, signal: AbortSignal.timeout(60000) });
  const mtext = await mr.text();
  if (!mr.ok) { result.models = `FAILED: HTTP ${mr.status} ${redact(mtext).slice(0, 500)}`; return; }
  const models = (JSON.parse(mtext).models || []);
  const listed = models.filter((m) => m.visibility === "list");
  log(`\nmodels: ${models.length} total, ${listed.length} with visibility=list`);
  listed.forEach((m) => log(`  - ${m.slug}  (${m.display_name})`));
  result.models = `OK (${listed.length} listed): ${listed.map((m) => m.slug).join(", ")}`;
  const model = process.env.SPIKE_MODEL || listed[0]?.slug;
  if (!model) { result.inference = "SKIPPED: no listed model"; return; }

  // ---- one streaming inference
  log(`\nInference request: POST /responses model=${model} store=false stream=true`);
  const ir = await fetch(`${RESOURCE}/responses`, {
    method: "POST", headers: { ...authz, "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, input: [{ role: "user", content: "Say exactly: Hello, world!" }], store: false, stream: true }),
  });
  if (!ir.ok) {
    const t = redact(await ir.text());
    result.inference = `FAILED before stream: HTTP ${ir.status} ${t.slice(0, 600)}`;
    return;
  }
  let text = "", completed = false, usage = null, buf = "";
  const dec = new TextDecoder();
  process.stdout.write("model output: ");
  for await (const chunk of ir.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "response.output_text.delta") { text += ev.delta; process.stdout.write(redact(ev.delta)); }
      else if (ev.type === "response.completed") { completed = true; usage = ev.response?.usage ?? null; }
      else if (ev.type === "response.failed") { const e = ev.response?.error; console.log(); result.inference = `FAILED mid-stream: code=${e?.code ?? "unknown_error"} message=${redact(e?.message ?? "")}`; return; }
      else if (ev.type === "response.incomplete") { console.log(); result.inference = `INCOMPLETE: ${JSON.stringify(ev.response?.incomplete_details ?? {})}`; return; }
    }
  }
  console.log();
  if (!completed) { result.inference = "FAILED: stream ended without response.completed"; return; }
  log("usage:", JSON.stringify(usage));
  result.inference = `OK (response.completed received; ${text.length} chars)`;
}

try { await main(); } catch (e) { result.notes.push("unexpected error: " + redact(e.stack || e.message)); }
log("\n================ RESULT ================");
log("authentication :", result.auth);
log("plan scope     :", result.scope);
log("model discovery:", result.models);
log("inference      :", result.inference);
result.notes.forEach((n) => log("note:", n));
log("(nothing was written to disk; tokens were never printed)");
process.exit(0);
