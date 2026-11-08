//! ChatGPT "Reasoner": official Sign in with ChatGPT open-source plan-usage flow (OAuth 2.0 authorization code
//! + PKCE, loopback redirect) and streamed Responses API calls. EXPERIMENTAL (ADR-0007/0008): OpenAI documents
//! this for Plus/Pro; other plans are unconfirmed and eligibility failures are reported honestly.
//!
//! Safety properties: the password is only ever typed into the user's browser at auth.openai.com; the refresh
//! token is kept in Windows Credential Manager, the access token only in memory; no token is logged or emitted;
//! no API key, cookies, website automation or undocumented endpoints are used.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::now_ms;
use crate::events::{hidden, truncate, ErrorKind, ProviderError};
use crate::secrets;

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const APP_NAME: &str = "Mushoku Guild";
const PREFERRED_PORT: u16 = 1455;
const CRED: &str = "chatgpt-oauth";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptStatus {
    pub connected: bool,
    pub label: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    refresh: String,
    client_id: String,
    label: Option<String>,
}

#[derive(Default)]
struct Session {
    access: Option<String>,
    expires_at_ms: i64,
}

#[derive(Default)]
pub struct ChatGpt {
    session: Mutex<Session>,
    pub cancel_connect: AtomicBool,
}

fn err(kind: ErrorKind, m: impl Into<String>) -> ProviderError {
    ProviderError::new(kind, m)
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(90)))
            .timeout_recv_body(Some(Duration::from_secs(900)))
            .build(),
    )
}

/// Removes anything token-shaped from text that may be shown or logged.
pub fn redact(s: &str, known: &[&str]) -> String {
    let mut out = s.to_string();
    for k in known.iter().filter(|k| k.len() > 8) {
        out = out.replace(k, "[REDACTED]");
    }
    out.split_inclusive(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'))
        .map(|w| {
            let core = w.trim_end_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'));
            if core.starts_with("eyJ") && core.len() > 20 {
                format!("[REDACTED_JWT]{}", &w[core.len()..])
            } else {
                w.to_string()
            }
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (percent_decode(k), percent_decode(v)))
        .collect()
}

fn random_b64(n: usize) -> Result<String, ProviderError> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).map_err(|e| err(ErrorKind::Other, format!("no secure random source: {e}")))?;
    Ok(B64.encode(buf))
}

fn jwt_claims(jwt: &str) -> Option<serde_json::Value> {
    let payload = jwt.split('.').nth(1)?;
    serde_json::from_slice(&B64.decode(payload).ok()?).ok()
}

fn mask_email(e: &str) -> String {
    match e.split_once('@') {
        Some((u, d)) => format!("{}***@{}", u.chars().next().unwrap_or('*'), d),
        None => "signed in".into(),
    }
}

/// OIDC checks on the ID token. The token is received directly from the token endpoint over TLS, which OIDC Core
/// §3.1.3.7(6) accepts in place of signature validation, so the signature is not re-verified here.
pub fn validate_id_token(id_token: &str, client_id: &str, nonce: &str, now_s: i64) -> Result<serde_json::Value, String> {
    let c = jwt_claims(id_token).ok_or("ID token is not a JWT")?;
    if c["iss"].as_str() != Some(ISSUER) {
        return Err("ID token issuer mismatch".into());
    }
    let aud_ok = match &c["aud"] {
        serde_json::Value::String(s) => s == client_id,
        serde_json::Value::Array(a) => a.iter().any(|v| v.as_str() == Some(client_id)),
        _ => false,
    };
    if !aud_ok {
        return Err("ID token audience mismatch".into());
    }
    if c["exp"].as_i64().unwrap_or(0) <= now_s {
        return Err("ID token expired".into());
    }
    if c["nonce"].as_str() != Some(nonce) {
        return Err("ID token nonce mismatch".into());
    }
    Ok(c)
}

fn open_browser(url: &str) -> Result<(), ProviderError> {
    if !url.starts_with("https://auth.openai.com/") {
        return Err(err(ErrorKind::Protocol, "refusing to open an unexpected URL"));
    }
    let mut cmd = std::process::Command::new("rundll32");
    cmd.args(["url.dll,FileProtocolHandler", url]);
    hidden(&mut cmd).spawn().map(|_| ()).map_err(|e| err(ErrorKind::Other, format!("could not open the browser: {e}")))
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(msg.as_bytes());
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Mushoku Guild</title><body style=\"font-family:sans-serif;background:#2b1d14;color:#f3e3c3;text-align:center;padding-top:20vh\"><h2>Mushoku Guild</h2><p>%MSG%</p>";

struct Callback {
    code: String,
    client_id: String,
}

fn wait_for_callback(listener: &TcpListener, state: &str, cancel: &AtomicBool) -> Result<Callback, ProviderError> {
    listener.set_nonblocking(true).map_err(|e| err(ErrorKind::Other, e.to_string()))?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(err(ErrorKind::Cancelled, "Sign-in cancelled."));
        }
        if Instant::now() > deadline {
            return Err(err(ErrorKind::Cancelled, "Timed out waiting for the browser sign-in (5 minutes)."));
        }
        let (mut s, _) = match listener.accept() {
            Ok(x) => x,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(err(ErrorKind::Other, e.to_string())),
        };
        let _ = s.set_nonblocking(false);
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 8192];
        let n = s.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).into_owned();
        let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
        let Some(query) = target.strip_prefix("/auth/callback?") else {
            respond(&mut s, "404 Not Found", "not found");
            continue;
        };
        let q = parse_query(query);
        if q.get("state").map(String::as_str) != Some(state) {
            respond(&mut s, "400 Bad Request", &PAGE.replace("%MSG%", "Sign-in rejected: the state value did not match."));
            return Err(err(ErrorKind::Protocol, "Sign-in rejected: state mismatch."));
        }
        if let Some(e) = q.get("error") {
            respond(&mut s, "400 Bad Request", &PAGE.replace("%MSG%", "Sign-in was not completed. You can close this tab."));
            let d = q.get("error_description").cloned().unwrap_or_default();
            let kind = if e == "access_denied" { ErrorKind::Cancelled } else { ErrorKind::Eligibility };
            return Err(err(kind, format!("Authorization failed: {e} {d}").trim().to_string()));
        }
        let (Some(code), Some(client_id)) = (q.get("code"), q.get("client_id")) else {
            respond(&mut s, "400 Bad Request", &PAGE.replace("%MSG%", "Incomplete callback."));
            return Err(err(ErrorKind::Protocol, "The callback had no code or no issued client id."));
        };
        respond(&mut s, "200 OK", &PAGE.replace("%MSG%", "Signed in. You can close this tab and return to Mushoku Guild."));
        return Ok(Callback { code: code.clone(), client_id: client_id.clone() });
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
}

fn token_error(status: u16, body: &str) -> ProviderError {
    let code = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or_default();
    if code == "invalid_grant" || status == 400 || status == 401 {
        err(ErrorKind::AuthExpired, "ChatGPT sign-in expired or was revoked. Connect ChatGPT again.")
    } else {
        err(ErrorKind::Other, format!("Token endpoint returned HTTP {status}: {}", truncate(&redact(body, &[]), 300)))
    }
}

impl ChatGpt {
    pub fn status(&self) -> ChatGptStatus {
        match secrets::load(CRED).and_then(|s| serde_json::from_str::<Stored>(&s).ok()) {
            Some(st) => ChatGptStatus { connected: true, label: st.label },
            None => ChatGptStatus { connected: false, label: None },
        }
    }

    pub fn disconnect(&self) {
        secrets::delete(CRED);
        *self.session.lock().unwrap_or_else(|p| p.into_inner()) = Session::default();
    }

    /// Full browser sign-in. Blocks until the user finishes, cancels, or 5 minutes pass.
    pub fn connect(&self, on_stage: &dyn Fn(&str, Option<String>)) -> Result<ChatGptStatus, ProviderError> {
        self.cancel_connect.store(false, Ordering::SeqCst);
        let state = random_b64(24)?;
        let nonce = random_b64(24)?;
        let verifier = random_b64(48)?;
        let challenge = B64.encode(Sha256::digest(verifier.as_bytes()).as_slice());
        let host_id = format!("urn:uuid:{}", random_b64(16)?);

        let listener = TcpListener::bind(("127.0.0.1", PREFERRED_PORT))
            .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
            .map_err(|e| err(ErrorKind::Other, format!("cannot open the local sign-in listener: {e}")))?;
        let port = listener.local_addr().map_err(|e| err(ErrorKind::Other, e.to_string()))?.port();
        let redirect = format!("http://127.0.0.1:{port}/auth/callback");

        let params = [
            ("client_id", "dynamic_agent_client"),
            ("agent_name_hint", APP_NAME),
            ("ext_agent_host_id", host_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect.as_str()),
            ("scope", SCOPE),
            ("resource", RESOURCE),
            ("state", state.as_str()),
            ("nonce", nonce.as_str()),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
        ];
        let url = format!("{AUTHORIZE}?{}", params.iter().map(|(k, v)| format!("{k}={}", percent_encode(v))).collect::<Vec<_>>().join("&"));
        on_stage("waiting_browser", Some(url.clone()));
        open_browser(&url)?;
        let cb = wait_for_callback(&listener, &state, &self.cancel_connect)?;
        drop(listener);
        on_stage("exchanging", None);

        let resp = agent()
            .post(TOKEN)
            .send_form([
                ("grant_type", "authorization_code"),
                ("client_id", cb.client_id.as_str()),
                ("code", cb.code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("resource", RESOURCE),
            ])
            .map_err(|e| err(ErrorKind::Network, format!("token request failed: {e}")))?;
        let status = resp.status().as_u16();
        let body = resp.into_body().read_to_string().map_err(|e| err(ErrorKind::Network, e.to_string()))?;
        if status != 200 {
            return Err(token_error(status, &body));
        }
        let tok: TokenResponse = serde_json::from_str(&body).map_err(|_| err(ErrorKind::Protocol, "unreadable token response"))?;
        let id = tok.id_token.as_deref().ok_or_else(|| err(ErrorKind::Protocol, "token response had no ID token"))?;
        let claims = validate_id_token(id, &cb.client_id, &nonce, now_ms() / 1000).map_err(|m| err(ErrorKind::Protocol, m))?;
        let scopes = tok.scope.clone().unwrap_or_default();
        if !scopes.split_whitespace().any(|s| s == "chatgpt.tokens.use.direct") {
            return Err(err(
                ErrorKind::Eligibility,
                "ChatGPT plan usage was not granted for this account (scope chatgpt.tokens.use.direct missing). OpenAI documents this flow for Plus and Pro; other plans are unconfirmed.",
            ));
        }
        let refresh = tok.refresh_token.clone().ok_or_else(|| err(ErrorKind::Protocol, "no refresh token was issued (offline_access)"))?;
        let label = claims["email"].as_str().map(mask_email);
        let stored = Stored { refresh, client_id: cb.client_id.clone(), label: label.clone() };
        secrets::save(CRED, &serde_json::to_string(&stored).map_err(|e| err(ErrorKind::Other, e.to_string()))?).map_err(|m| err(ErrorKind::Other, m))?;
        let mut s = self.session.lock().unwrap_or_else(|p| p.into_inner());
        s.access = Some(tok.access_token);
        s.expires_at_ms = now_ms() + tok.expires_in.unwrap_or(3000) * 1000;
        Ok(ChatGptStatus { connected: true, label })
    }

    /// A valid access token, refreshing (and rotating the stored refresh token) when needed.
    pub fn access_token(&self) -> Result<String, ProviderError> {
        {
            let s = self.session.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(a) = &s.access {
                if s.expires_at_ms - 60_000 > now_ms() {
                    return Ok(a.clone());
                }
            }
        }
        let mut stored: Stored = secrets::load(CRED)
            .and_then(|s| serde_json::from_str(&s).ok())
            .ok_or_else(|| err(ErrorKind::NotConnected, "ChatGPT is not connected."))?;
        let resp = agent()
            .post(TOKEN)
            .send_form([
                ("grant_type", "refresh_token"),
                ("client_id", stored.client_id.as_str()),
                ("refresh_token", stored.refresh.as_str()),
                ("resource", RESOURCE),
            ])
            .map_err(|e| err(ErrorKind::Network, format!("could not reach ChatGPT sign-in: {e}")))?;
        let status = resp.status().as_u16();
        let body = resp.into_body().read_to_string().map_err(|e| err(ErrorKind::Network, e.to_string()))?;
        if status != 200 {
            let e = token_error(status, &body);
            if e.kind == ErrorKind::AuthExpired {
                self.disconnect();
            }
            return Err(e);
        }
        let tok: TokenResponse = serde_json::from_str(&body).map_err(|_| err(ErrorKind::Protocol, "unreadable refresh response"))?;
        if let Some(r) = tok.refresh_token {
            stored.refresh = r;
            if let Ok(j) = serde_json::to_string(&stored) {
                let _ = secrets::save(CRED, &j);
            }
        }
        let mut s = self.session.lock().unwrap_or_else(|p| p.into_inner());
        s.access = Some(tok.access_token.clone());
        s.expires_at_ms = now_ms() + tok.expires_in.unwrap_or(3000) * 1000;
        Ok(tok.access_token)
    }

    fn api_error(&self, status: u16, body: &str) -> ProviderError {
        let access = self.session.lock().unwrap_or_else(|p| p.into_inner()).access.clone().unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from).or_else(|| v["detail"].as_str().map(String::from)))
            .unwrap_or_else(|| body.to_string());
        let msg = truncate(&redact(&msg, &[&access]), 400);
        match status {
            401 => err(ErrorKind::AuthExpired, "ChatGPT rejected the sign-in. Connect ChatGPT again."),
            403 => err(ErrorKind::Eligibility, format!("ChatGPT refused plan usage for this account (HTTP 403): {msg}")),
            429 => err(ErrorKind::UsageLimit, format!("ChatGPT usage limit or rate limit reached: {msg}")),
            _ => err(ErrorKind::Other, format!("ChatGPT returned HTTP {status}: {msg}")),
        }
    }

    pub fn models(&self) -> Result<Vec<Model>, ProviderError> {
        let token = self.access_token()?;
        let resp = agent()
            .get(&format!("{RESOURCE}/models"))
            .header("authorization", &format!("Bearer {token}"))
            .call()
            .map_err(|e| err(ErrorKind::Network, format!("could not reach ChatGPT: {e}")))?;
        let status = resp.status().as_u16();
        let body = resp.into_body().read_to_string().map_err(|e| err(ErrorKind::Network, e.to_string()))?;
        if status != 200 {
            return Err(self.api_error(status, &body));
        }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| err(ErrorKind::Protocol, "unreadable model list"))?;
        Ok(v["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|m| m["visibility"].as_str() == Some("list"))
                    .filter_map(|m| {
                        let slug = m["slug"].as_str()?.to_string();
                        let display_name = m["display_name"].as_str().unwrap_or(&slug).to_string();
                        Some(Model { slug, display_name })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Streams one response; `on_delta` receives text increments. Returns the full text.
    pub fn stream(
        &self,
        model: &str,
        instructions: &str,
        messages: &[(String, String)],
        cancel: &AtomicBool,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<String, ProviderError> {
        let token = self.access_token()?;
        let build = |fold: bool| {
            let mut input: Vec<serde_json::Value> = messages.iter().map(|(r, t)| serde_json::json!({"role": r, "content": t})).collect();
            let mut body = serde_json::json!({"model": model, "store": false, "stream": true});
            if fold {
                if let Some(first) = input.first_mut() {
                    let t = first["content"].as_str().unwrap_or("").to_string();
                    first["content"] = serde_json::Value::String(format!("{instructions}\n\n---\n\n{t}"));
                }
            } else {
                body["instructions"] = serde_json::Value::String(instructions.to_string());
            }
            body["input"] = serde_json::Value::Array(input);
            body
        };
        let send = |fold: bool| {
            agent()
                .post(&format!("{RESOURCE}/responses"))
                .header("authorization", &format!("Bearer {token}"))
                .send_json(build(fold))
                .map_err(|e| err(ErrorKind::Network, format!("could not reach ChatGPT: {e}")))
        };
        let mut resp = send(false)?;
        if resp.status().as_u16() == 400 {
            let body = resp.body_mut().read_to_string().unwrap_or_default();
            if body.contains("instructions") {
                resp = send(true)?; // some deployments reject `instructions`; fold it into the first message instead
            } else {
                return Err(self.api_error(400, &body));
            }
        }
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.body_mut().read_to_string().unwrap_or_default();
            return Err(self.api_error(status, &body));
        }
        let mut reader = BufReader::new(resp.into_body().into_reader());
        let mut text = String::new();
        let mut completed = false;
        let mut data = String::new();
        let mut line = String::new();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(err(ErrorKind::Cancelled, "Cancelled."));
            }
            line.clear();
            let n = reader.read_line(&mut line).map_err(|e| err(ErrorKind::Network, format!("the stream was interrupted: {e}")))?;
            if n == 0 {
                break;
            }
            let l = line.trim_end_matches(['\r', '\n']);
            if let Some(d) = l.strip_prefix("data:") {
                data.push_str(d.trim_start());
                continue;
            }
            if !l.is_empty() {
                continue;
            }
            if data.is_empty() || data == "[DONE]" {
                data.clear();
                continue;
            }
            let ev: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => {
                    data.clear();
                    continue;
                }
            };
            data.clear();
            match ev["type"].as_str().unwrap_or("") {
                "response.output_text.delta" => {
                    if let Some(d) = ev["delta"].as_str() {
                        text.push_str(d);
                        on_delta(d);
                    }
                }
                "response.completed" => {
                    completed = true;
                    break;
                }
                "response.failed" => {
                    let code = ev["response"]["error"]["code"].as_str().unwrap_or("unknown_error");
                    let m = ev["response"]["error"]["message"].as_str().unwrap_or("");
                    let kind = if code.contains("limit") || code.contains("quota") { ErrorKind::UsageLimit } else { ErrorKind::Other };
                    return Err(err(kind, format!("ChatGPT reported a failure ({code}): {}", truncate(&redact(m, &[&token]), 300))));
                }
                "response.incomplete" => {
                    return Err(err(ErrorKind::Other, format!("ChatGPT returned an incomplete response: {}", ev["response"]["incomplete_details"])));
                }
                _ => {}
            }
        }
        if !completed && text.is_empty() {
            return Err(err(ErrorKind::Protocol, "The stream ended without a response."));
        }
        if !completed {
            return Err(err(ErrorKind::Network, "The stream ended before the response was complete."));
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: serde_json::Value) -> String {
        format!("{}.{}.sig", B64.encode(b"{\"alg\":\"RS256\"}"), B64.encode(claims.to_string()))
    }

    #[test]
    fn id_token_checks_reject_wrong_nonce_audience_issuer_and_expiry() {
        let ok = serde_json::json!({"iss": ISSUER, "aud": ["cid"], "exp": 2000, "nonce": "n"});
        assert!(validate_id_token(&jwt(ok.clone()), "cid", "n", 1000).is_ok());
        assert!(validate_id_token(&jwt(ok.clone()), "cid", "other", 1000).is_err());
        assert!(validate_id_token(&jwt(ok.clone()), "wrong", "n", 1000).is_err());
        assert!(validate_id_token(&jwt(ok.clone()), "cid", "n", 3000).is_err());
        let bad_iss = serde_json::json!({"iss": "https://evil.example", "aud": "cid", "exp": 2000, "nonce": "n"});
        assert!(validate_id_token(&jwt(bad_iss), "cid", "n", 1000).is_err());
    }

    #[test]
    fn query_parsing_decodes_percent_escapes() {
        let q = parse_query("code=a%2Fb&state=x%20y&client_id=c");
        assert_eq!(q["code"], "a/b");
        assert_eq!(q["state"], "x y");
        assert_eq!(percent_encode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn redaction_masks_jwts_and_known_tokens() {
        let r = redact("bad token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghij and secret-value-123456", &["secret-value-123456"]);
        assert!(!r.contains("eyJhbGci") && !r.contains("secret-value"));
        assert!(r.contains("[REDACTED_JWT]") && r.contains("[REDACTED]"));
    }
}
