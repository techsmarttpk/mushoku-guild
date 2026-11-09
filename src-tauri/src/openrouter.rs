//! OpenRouter provider (ADR-0015): FREE models only, API key in Windows Credential Manager, all traffic from Rust.
//!
//! Free-only enforcement has four independent layers, any one of which stops a paid request:
//! 1. the catalogue keeps a model only if its id ends in `:free` AND every pricing field present is numerically zero
//!    (missing, unparsable or negative pricing excludes it, so "variable"/router models never qualify);
//! 2. a model is re-validated against a fresh catalogue before it is recruited and before a request when the cached
//!    catalogue is older than ten minutes (`ensure_free`);
//! 3. `stream` itself refuses any model id that does not end in `:free` before touching the network;
//! 4. requests name exactly one model, never a `models` fallback list or router, and disable provider fallbacks.
//! There is no fallback to another model: a failed request is reported, never re-sent elsewhere.
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::commands::AppState;
use crate::db::{now_ms, Db};
use crate::events::{truncate, ErrorKind, ProviderError};
use crate::provider::{Capabilities, ChatOutcome, ChatProvider, ChatRequest, Usage};
use crate::secrets;

pub const BASE: &str = "https://openrouter.ai/api/v1";
const KEY_NAME: &str = "openrouter_api_key";
/// A catalogue younger than this is trusted for the "still free?" check before a request.
const FRESH_MS: i64 = 10 * 60 * 1000;
const MAX_KEY_LEN: usize = 400;

fn err(kind: ErrorKind, m: impl Into<String>) -> ProviderError {
    ProviderError::new(kind, m)
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            // never follow a redirect: the API key must not be re-sent to another host
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .timeout_recv_body(Some(Duration::from_secs(600)))
            .build(),
    )
}

/// Removes the key (and anything key-shaped) from text that may be shown or logged.
pub fn scrub(s: &str, key: Option<&str>) -> String {
    let mut out = s.to_string();
    if let Some(k) = key.filter(|k| k.len() >= 8) {
        out = out.replace(k, "[REDACTED]");
    }
    crate::project_context::redact(&out)
}

// ---------------------------------------------------------------- free-model eligibility (pure)

/// `Ok` only for a model that is verifiably free. Anything doubtful is excluded, never guessed.
pub fn eligibility(m: &Value) -> Result<(), String> {
    let id = m["id"].as_str().filter(|s| !s.trim().is_empty()).ok_or("the model has no id")?;
    if !id.ends_with(":free") {
        return Err("the id is not a `:free` variant".into());
    }
    let pricing = m["pricing"].as_object().ok_or("pricing metadata is missing")?;
    for required in ["prompt", "completion"] {
        if !pricing.contains_key(required) {
            return Err(format!("the `{required}` price is missing"));
        }
    }
    for (field, v) in pricing {
        let n = match v {
            Value::String(s) => s.trim().parse::<f64>().ok(),
            Value::Number(n) => n.as_f64(),
            _ => None,
        };
        match n {
            Some(x) if x == 0.0 => {}
            Some(x) if x.is_nan() || x < 0.0 => return Err(format!("the `{field}` price is not a valid zero")),
            Some(_) => return Err(format!("the `{field}` price is not zero")),
            None => return Err(format!("the `{field}` price is unreadable")),
        }
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrModel {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub context_length: Option<i64>,
    pub description: String,
    pub input_modalities: Vec<String>,
    pub output_modalities: Vec<String>,
    pub caps: Capabilities,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// "text+image->text" style modality strings, used when the structured arrays are absent.
fn parse_modality(s: &str) -> (Vec<String>, Vec<String>) {
    let (i, o) = s.split_once("->").unwrap_or((s, ""));
    let split = |t: &str| t.split('+').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>();
    (split(i), split(o))
}

pub fn normalize(m: &Value) -> OrModel {
    let id = m["id"].as_str().unwrap_or("").to_string();
    let arch = &m["architecture"];
    let (mut inp, mut out) = (strings(&arch["input_modalities"]), strings(&arch["output_modalities"]));
    if inp.is_empty() && out.is_empty() {
        if let Some(s) = arch["modality"].as_str() {
            (inp, out) = parse_modality(s);
        }
    }
    let params = strings(&m["supported_parameters"]);
    let has = |p: &str| params.iter().any(|x| x == p);
    let name = m["name"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or(&id).to_string();
    OrModel {
        vendor: id.split('/').next().unwrap_or("").to_string(),
        context_length: m["context_length"].as_i64().or_else(|| m["top_provider"]["context_length"].as_i64()),
        description: truncate(m["description"].as_str().unwrap_or("").trim(), 600),
        caps: Capabilities {
            text_input: inp.iter().any(|x| x == "text"),
            text_output: out.iter().any(|x| x == "text"),
            image_input: inp.iter().any(|x| x == "image"),
            image_output: out.iter().any(|x| x == "image"),
            tools: has("tools"),
            structured_output: has("structured_outputs") || has("response_format"),
            streaming: true,
        },
        input_modalities: inp,
        output_modalities: out,
        id,
        name,
    }
}

// ---------------------------------------------------------------- HTTP client

pub struct OpenRouter {
    base: String,
    key: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub free_tier: bool,
    pub limit_remaining: Option<f64>,
}

impl OpenRouter {
    pub fn live() -> Self {
        OpenRouter { base: BASE.into(), key: secrets::load(KEY_NAME) }
    }
    pub fn with(base: &str, key: Option<&str>) -> Self {
        OpenRouter { base: base.trim_end_matches('/').to_string(), key: key.map(str::to_string) }
    }

    fn api_error(&self, status: u16, body: &str) -> ProviderError {
        let msg = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_else(|| body.to_string());
        let msg = truncate(&scrub(&msg, self.key.as_deref()), 300);
        match status {
            401 => err(ErrorKind::AuthExpired, "OpenRouter rejected the API key. Check it in the Guild tab and connect again."),
            402 => err(ErrorKind::Eligibility, "OpenRouter asked for credits. Mushoku Guild only uses free models, so the request was stopped and nothing was charged."),
            403 => err(ErrorKind::Eligibility, format!("OpenRouter refused the request (HTTP 403): {msg}")),
            404 => err(ErrorKind::NotFound, "OpenRouter no longer offers this model."),
            429 => err(ErrorKind::UsageLimit, "OpenRouter's free-model rate limit was reached (free models are limited per minute and per day). Try again later. Nothing was sent to another model."),
            500..=599 => err(ErrorKind::Network, format!("OpenRouter had a problem (HTTP {status}): {msg}")),
            _ => err(ErrorKind::Other, format!("OpenRouter returned HTTP {status}: {msg}")),
        }
    }

    fn get(&self, path: &str, auth: bool) -> Result<String, ProviderError> {
        let mut req = agent().get(&format!("{}{path}", self.base)).header("x-title", "Mushoku Guild");
        if auth {
            let key = self.key.as_deref().ok_or_else(|| err(ErrorKind::NotConnected, "Connect OpenRouter first (Guild tab)."))?;
            req = req.header("authorization", &format!("Bearer {key}"));
        }
        let mut resp = req.call().map_err(|e| err(ErrorKind::Network, format!("could not reach OpenRouter: {}", scrub(&e.to_string(), self.key.as_deref()))))?;
        let status = resp.status().as_u16();
        let body = resp.body_mut().read_to_string().map_err(|e| err(ErrorKind::Network, scrub(&e.to_string(), self.key.as_deref())))?;
        if status != 200 {
            return Err(self.api_error(status, &body));
        }
        Ok(body)
    }

    /// Validates the key. The response carries a masked key label; it is deliberately not forwarded.
    pub fn check_key(&self) -> Result<KeyInfo, ProviderError> {
        let v: Value = serde_json::from_str(&self.get("/key", true)?).map_err(|_| err(ErrorKind::Protocol, "OpenRouter returned an unreadable key check."))?;
        Ok(KeyInfo { free_tier: v["data"]["is_free_tier"].as_bool().unwrap_or(false), limit_remaining: v["data"]["limit_remaining"].as_f64() })
    }

    /// The raw model list (public endpoint: the key is not sent).
    pub fn models(&self) -> Result<Vec<Value>, ProviderError> {
        let v: Value = serde_json::from_str(&self.get("/models", false)?).map_err(|_| err(ErrorKind::Protocol, "OpenRouter returned an unreadable model list."))?;
        v["data"].as_array().cloned().filter(|a| !a.is_empty()).ok_or_else(|| err(ErrorKind::Protocol, "OpenRouter returned an empty model list; nothing was changed."))
    }
}

impl ChatProvider for OpenRouter {
    fn stream(&self, req: &ChatRequest, cancel: &AtomicBool, on_delta: &mut dyn FnMut(&str)) -> Result<ChatOutcome, ProviderError> {
        // Layer 3 of the free-only guard: never even attempt a request for anything but an explicit `:free` model.
        if !req.model.ends_with(":free") || req.model.contains(',') || req.model.contains(char::is_whitespace) {
            return Err(err(ErrorKind::Eligibility, "Only free OpenRouter models (`:free`) can be used. The request was not sent."));
        }
        let key = self.key.as_deref().ok_or_else(|| err(ErrorKind::NotConnected, "Connect OpenRouter first (Guild tab)."))?;
        let mut messages: Vec<Value> = Vec::new();
        if let Some(s) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
            messages.push(json!({"role": "system", "content": s}));
        }
        messages.extend(req.messages.iter().map(|(r, t)| json!({"role": r, "content": t})));
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            // one model only: no `models` list, no router, and no provider fallbacks
            "provider": {"allow_fallbacks": false},
        });
        if let Some(n) = req.max_tokens {
            body["max_tokens"] = json!(n);
        }
        let mut resp = agent()
            .post(&format!("{}/chat/completions", self.base))
            .header("authorization", &format!("Bearer {key}"))
            .header("x-title", "Mushoku Guild")
            .send_json(body)
            .map_err(|e| err(ErrorKind::Network, format!("could not reach OpenRouter: {}", scrub(&e.to_string(), Some(key)))))?;
        let status = resp.status().as_u16();
        if status != 200 {
            let b = resp.body_mut().read_to_string().unwrap_or_default();
            return Err(self.api_error(status, &b));
        }
        let mut reader = BufReader::new(resp.into_body().into_reader());
        let mut text = String::new();
        let mut usage: Option<Usage> = None;
        let mut finished = false;
        let mut line = String::new();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(err(ErrorKind::Cancelled, "Cancelled."));
            }
            line.clear();
            let n = reader.read_line(&mut line).map_err(|e| err(ErrorKind::Network, format!("the stream was interrupted: {}", scrub(&e.to_string(), Some(key)))))?;
            if n == 0 {
                break;
            }
            let l = line.trim_end_matches(['\r', '\n']);
            // `: OPENROUTER PROCESSING` keep-alive comments and blank separators carry nothing
            let Some(data) = l.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                finished = true;
                break;
            }
            let Ok(ev) = serde_json::from_str::<Value>(data) else { continue };
            if !ev["error"].is_null() {
                let m = ev["error"]["message"].as_str().unwrap_or("the model reported an error");
                let code = ev["error"]["code"].as_u64().unwrap_or(0) as u16;
                // mid-stream errors arrive with HTTP 200; map the embedded code like a normal status
                return Err(if code >= 400 { self.api_error(code, &json!({"error": {"message": m}}).to_string()) } else { err(ErrorKind::Other, truncate(&scrub(m, Some(key)), 300)) });
            }
            if let Some(d) = ev["choices"][0]["delta"]["content"].as_str().filter(|d| !d.is_empty()) {
                text.push_str(d);
                on_delta(d);
            }
            if ev["choices"][0]["finish_reason"].as_str() == Some("error") {
                return Err(err(ErrorKind::Other, "The model stopped with an error. Try again or choose another free model."));
            }
            if let Some(u) = ev["usage"].as_object().filter(|u| !u.is_empty()) {
                usage = Some(Usage {
                    prompt_tokens: u.get("prompt_tokens").and_then(Value::as_u64),
                    completion_tokens: u.get("completion_tokens").and_then(Value::as_u64),
                    total_tokens: u.get("total_tokens").and_then(Value::as_u64),
                    cost: u.get("cost").and_then(Value::as_f64),
                });
            }
        }
        if !finished && text.is_empty() {
            return Err(err(ErrorKind::Protocol, "The stream ended without a response."));
        }
        if !finished {
            return Err(err(ErrorKind::Network, "The stream ended before the response was complete."));
        }
        Ok(ChatOutcome { text, usage })
    }
}

// ---------------------------------------------------------------- catalogue storage

impl Db {
    pub fn or_replace_catalog(&self, models: &[OrModel], total: usize) -> Result<(), String> {
        let mut c = self.c();
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM or_models", []).map_err(|e| e.to_string())?;
        for m in models {
            tx.execute(
                "INSERT INTO or_models(id,name,vendor,context_length,description,input_modalities,output_modalities,caps) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![m.id, m.name, m.vendor, m.context_length, m.description, json!(m.input_modalities).to_string(), json!(m.output_modalities).to_string(), serde_json::to_string(&m.caps).unwrap_or_else(|_| "{}".into())],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(c);
        let _ = self.set_setting("or_catalog_at", &now_ms().to_string());
        let _ = self.set_setting("or_catalog_total", &total.to_string());
        Ok(())
    }

    fn or_row(r: &rusqlite::Row) -> rusqlite::Result<OrModel> {
        let list = |i: usize| -> rusqlite::Result<Vec<String>> { Ok(serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or_default()) };
        Ok(OrModel {
            id: r.get(0)?,
            name: r.get(1)?,
            vendor: r.get(2)?,
            context_length: r.get(3)?,
            description: r.get(4)?,
            input_modalities: list(5)?,
            output_modalities: list(6)?,
            caps: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
        })
    }

    pub fn or_model(&self, id: &str) -> Option<OrModel> {
        use rusqlite::OptionalExtension;
        self.c().query_row("SELECT id,name,vendor,context_length,description,input_modalities,output_modalities,caps FROM or_models WHERE id=?1", [id], Self::or_row).optional().ok().flatten()
    }

    /// One page of the eligible catalogue (name order). Search matches name, id and description.
    pub fn or_page(&self, query: &str, offset: i64, limit: i64) -> (Vec<OrModel>, i64) {
        let c = self.c();
        let like = format!("%{}%", query.trim().replace(['%', '_'], ""));
        let total: i64 = c.query_row("SELECT COUNT(*) FROM or_models WHERE name LIKE ?1 OR id LIKE ?1 OR description LIKE ?1", [&like], |r| r.get(0)).unwrap_or(0);
        let mut st = c
            .prepare("SELECT id,name,vendor,context_length,description,input_modalities,output_modalities,caps FROM or_models WHERE name LIKE ?1 OR id LIKE ?1 OR description LIKE ?1 ORDER BY name COLLATE NOCASE, id LIMIT ?2 OFFSET ?3")
            .expect("sql");
        let rows = st.query_map(params![like, limit, offset], Self::or_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default();
        (rows, total)
    }

    pub fn or_catalog_age(&self) -> Option<i64> {
        self.setting("or_catalog_at").and_then(|s| s.parse::<i64>().ok()).map(|t| now_ms() - t)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrStatus {
    pub connected: bool,
    pub catalog_at: Option<i64>,
    pub eligible: i64,
    pub total: i64,
}

pub fn status_of(db: &Db) -> OrStatus {
    let eligible: i64 = db.c().query_row("SELECT COUNT(*) FROM or_models", [], |r| r.get(0)).unwrap_or(0);
    OrStatus {
        connected: secrets::load(KEY_NAME).is_some(),
        catalog_at: db.setting("or_catalog_at").and_then(|s| s.parse().ok()),
        eligible,
        total: db.setting("or_catalog_total").and_then(|s| s.parse().ok()).unwrap_or(0),
    }
}

/// Downloads the catalogue, keeps only verifiably free models and re-evaluates every recruited model against it.
pub fn refresh(db: &Db, client: &OpenRouter) -> Result<(usize, usize), ProviderError> {
    let raw = client.models()?;
    let mut verdicts: std::collections::HashMap<String, Result<OrModel, String>> = std::collections::HashMap::new();
    let mut free: Vec<OrModel> = Vec::new();
    for m in &raw {
        let Some(id) = m["id"].as_str() else { continue };
        match eligibility(m) {
            Ok(()) => {
                let n = normalize(m);
                free.push(n.clone());
                verdicts.insert(id.to_string(), Ok(n));
            }
            Err(why) => {
                verdicts.insert(id.to_string(), Err(why));
            }
        }
    }
    db.or_replace_catalog(&free, raw.len()).map_err(|m| err(ErrorKind::Other, m))?;
    db.guild_apply_catalog(&verdicts);
    Ok((free.len(), raw.len()))
}

/// Layer 2: the model must be free according to a catalogue no older than ten minutes (a fresh download is made if needed).
pub fn ensure_free(db: &Db, client: &OpenRouter, model_id: &str) -> Result<OrModel, ProviderError> {
    if !model_id.ends_with(":free") {
        return Err(err(ErrorKind::Eligibility, "Only free OpenRouter models (`:free`) can be used."));
    }
    let age = db.or_catalog_age();
    let known = db.or_model(model_id);
    // an unknown model triggers a refresh at most once a minute, so a typo cannot hammer the API
    let must = age.map(|a| a > FRESH_MS || (known.is_none() && a > 60_000)).unwrap_or(true);
    if must {
        refresh(db, client)?;
    }
    db.or_model(model_id).ok_or_else(|| err(ErrorKind::Eligibility, "This model is not in OpenRouter's free catalogue right now, so it cannot be used."))
}

// ---------------------------------------------------------------- commands

type R<T> = Result<T, ProviderError>;

fn join_err(e: tauri::Error) -> ProviderError {
    err(ErrorKind::Other, e.to_string())
}

#[tauri::command]
pub fn or_status(state: State<'_, AppState>) -> OrStatus {
    status_of(&state.db)
}

/// The key travels from the form to Rust exactly once; it is validated, stored in the Credential Manager and forgotten.
#[tauri::command]
pub async fn or_connect(state: State<'_, AppState>, api_key: String) -> R<OrStatus> {
    let key = api_key.trim().to_string();
    if key.len() < 8 || key.len() > MAX_KEY_LEN || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(err(ErrorKind::Other, "That does not look like an OpenRouter API key."));
    }
    let probe = key.clone();
    tauri::async_runtime::spawn_blocking(move || OpenRouter::with(BASE, Some(&probe)).check_key()).await.map_err(join_err)??;
    secrets::save(KEY_NAME, &key).map_err(|m| err(ErrorKind::Other, scrub(&m, Some(&key))))?;
    Ok(status_of(&state.db))
}

#[tauri::command]
pub async fn or_test_connection() -> R<KeyInfo> {
    tauri::async_runtime::spawn_blocking(|| OpenRouter::live().check_key()).await.map_err(join_err)?
}

#[tauri::command]
pub fn or_disconnect(state: State<'_, AppState>) -> OrStatus {
    secrets::delete(KEY_NAME);
    status_of(&state.db)
}

#[tauri::command]
pub async fn or_refresh_catalog(state: State<'_, AppState>) -> R<OrStatus> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || refresh(&db, &OpenRouter::live()).map(|_| status_of(&db))).await.map_err(join_err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrPage {
    pub models: Vec<OrModel>,
    pub total: i64,
}

#[tauri::command]
pub fn or_catalog(state: State<'_, AppState>, query: String, offset: i64, limit: i64) -> OrPage {
    let (models, total) = state.db.or_page(&query, offset.max(0), limit.clamp(1, 60));
    OrPage { models, total }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrTest {
    pub text: String,
    pub latency_ms: u64,
    pub usage: Option<Usage>,
}

#[tauri::command]
pub async fn or_test_model(state: State<'_, AppState>, model_id: String, prompt: String) -> R<OrTest> {
    let prompt: String = prompt.trim().chars().take(500).collect();
    if prompt.is_empty() {
        return Err(err(ErrorKind::Other, "Type a short test prompt first."));
    }
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = OpenRouter::live();
        if client.key.is_none() {
            return Err(err(ErrorKind::NotConnected, "Connect OpenRouter first."));
        }
        ensure_free(&db, &client, &model_id)?;
        let t0 = Instant::now();
        let out = client.stream(&ChatRequest { model: model_id, system: None, messages: vec![("user".into(), prompt)], max_tokens: Some(256) }, &AtomicBool::new(false), &mut |_| {})?;
        Ok(OrTest { text: out.text, latency_ms: t0.elapsed().as_millis() as u64, usage: out.usage })
    })
    .await
    .map_err(join_err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const FAKE_KEY: &str = "sk-or-v1-0000000000000000000000000000000000000000000000000000fake";

    fn model(id: &str, pricing: Value) -> Value {
        json!({"id": id, "name": "Test: Model", "context_length": 32768, "description": "d", "pricing": pricing,
               "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
               "supported_parameters": ["tools", "temperature", "structured_outputs"]})
    }
    fn zero() -> Value {
        json!({"prompt": "0", "completion": "0", "request": "0", "image": "0", "web_search": "0", "internal_reasoning": "0"})
    }

    /// A one-shot-per-connection mock of the OpenRouter API. Records every request (head + body).
    fn mock(routes: Vec<(&'static str, u16, &'static str, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                loop {
                    let n = s.read(&mut tmp).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(h) = text.find("\r\n\r\n") {
                        let len = text[..h].to_lowercase().split("content-length:").nth(1).and_then(|x| x.split("\r\n").next()).and_then(|x| x.trim().parse::<usize>().ok()).unwrap_or(0);
                        if buf.len() >= h + 4 + len {
                            break;
                        }
                    }
                }
                let req = String::from_utf8_lossy(&buf).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                log.lock().unwrap().push(req);
                let (status, ctype, body) = routes.iter().find(|(p, ..)| line.contains(p)).map(|(_, st, ct, b)| (*st, *ct, b.clone())).unwrap_or((404, "application/json", "{}".into()));
                let head = format!("HTTP/1.1 {status} X\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
            }
        });
        (base, seen)
    }

    fn sse(chunks: &[&str]) -> String {
        chunks.iter().map(|c| format!("data: {c}\n\n")).collect()
    }

    #[test]
    fn only_verifiably_free_models_are_eligible() {
        assert!(eligibility(&model("meta-llama/llama-3.3-70b-instruct:free", zero())).is_ok());
        assert!(eligibility(&model("x/y:free", json!({"prompt": 0, "completion": 0}))).is_ok(), "numeric zeros are fine");
        // paid variants and free names with a price
        assert!(eligibility(&model("meta-llama/llama-3.3-70b-instruct", zero())).is_err(), "no :free suffix");
        assert!(eligibility(&model("x/y:free", json!({"prompt": "0", "completion": "0.000001"}))).is_err(), "non-zero completion");
        assert!(eligibility(&model("x/y:free", json!({"prompt": "0.0000001", "completion": "0"}))).is_err());
        assert!(eligibility(&model("x/y:free", json!({"prompt": "0", "completion": "0", "request": "0.01"}))).is_err(), "any other charge excludes it");
        assert!(eligibility(&model("x/y:free", json!({"prompt": "0", "completion": "0", "image": "0.001"}))).is_err());
        // missing or ambiguous metadata
        assert!(eligibility(&json!({"id": "x/y:free"})).is_err(), "no pricing object");
        assert!(eligibility(&model("x/y:free", json!({"prompt": "0"}))).is_err(), "completion missing");
        assert!(eligibility(&model("x/y:free", json!({"prompt": "0", "completion": null}))).is_err(), "null price");
        assert!(eligibility(&model("x/y:free", json!({"prompt": "free", "completion": "0"}))).is_err(), "unparsable price");
        assert!(eligibility(&model("x/y:free", json!({"prompt": "-1", "completion": "-1"}))).is_err(), "variable-price routers use -1");
        assert!(eligibility(&model("openrouter/auto", json!({"prompt": "-1", "completion": "-1"}))).is_err());
        assert!(eligibility(&model("openrouter/free", zero())).is_err(), "a router that merely says free is not a :free model");
        assert!(eligibility(&model("", zero())).is_err());
    }

    #[test]
    fn model_metadata_is_normalised_without_inventing_capabilities() {
        let n = normalize(&model("google/gemma-3-27b-it:free", zero()));
        assert_eq!((n.vendor.as_str(), n.name.as_str(), n.context_length), ("google", "Test: Model", Some(32768)));
        assert!(n.caps.text_input && n.caps.text_output && n.caps.image_input && n.caps.tools && n.caps.structured_output);
        assert!(!n.caps.image_output, "image generation is only reported when the output modalities list it");
        let plain = normalize(&json!({"id": "a/b:free", "architecture": {"modality": "text->text"}, "supported_parameters": []}));
        assert!(plain.caps.text_output && !plain.caps.image_input && !plain.caps.tools && !plain.caps.structured_output);
        assert_eq!(plain.name, "a/b:free");
    }

    #[test]
    fn the_catalogue_keeps_only_free_models_and_pages_through_them() {
        let list: Vec<Value> = (0..45)
            .map(|i| model(&format!("v/m{i:02}:free"), zero()))
            .chain([model("v/paid", json!({"prompt": "0.000002", "completion": "0.000006"})), model("v/paid2:free", json!({"prompt": "0", "completion": "0.1"})), json!({"id": "v/none:free"})])
            .collect();
        let body = json!({"data": list}).to_string();
        let (base, _) = mock(vec![("/models", 200, "application/json", body)]);
        let db = Db::open_in_memory();
        let (free, total) = refresh(&db, &OpenRouter::with(&base, None)).unwrap();
        assert_eq!((free, total), (45, 48));
        let st = status_of(&db);
        assert_eq!((st.eligible, st.total), (45, 48));
        let (p1, n) = db.or_page("", 0, 20);
        let (p3, _) = db.or_page("", 40, 20);
        assert_eq!((p1.len(), n, p3.len()), (20, 45, 5));
        assert!(db.or_model("v/paid").is_none() && db.or_model("v/paid2:free").is_none() && db.or_model("v/none:free").is_none());
        assert_eq!(db.or_page("m07", 0, 20).1, 1);
    }

    #[test]
    fn an_empty_or_failed_catalogue_never_wipes_the_previous_one() {
        let db = Db::open_in_memory();
        db.or_replace_catalog(&[normalize(&model("v/keep:free", zero()))], 1).unwrap();
        let (empty, _) = mock(vec![("/models", 200, "application/json", json!({"data": []}).to_string())]);
        assert!(refresh(&db, &OpenRouter::with(&empty, None)).is_err());
        let (down, _) = mock(vec![("/models", 503, "application/json", "{}".into())]);
        assert!(refresh(&db, &OpenRouter::with(&down, None)).is_err());
        assert!(db.or_model("v/keep:free").is_some());
    }

    #[test]
    fn a_model_that_stops_being_free_is_refused_even_though_it_is_cached() {
        let db = Db::open_in_memory();
        db.or_replace_catalog(&[normalize(&model("v/m:free", zero()))], 1).unwrap();
        // age the cache past the freshness window
        db.set_setting("or_catalog_at", &(now_ms() - FRESH_MS - 1000).to_string()).unwrap();
        let now_paid = json!({"data": [model("v/m:free", json!({"prompt": "0.000001", "completion": "0.000001"}))]}).to_string();
        let (base, seen) = mock(vec![("/models", 200, "application/json", now_paid)]);
        let e = ensure_free(&db, &OpenRouter::with(&base, None), "v/m:free").unwrap_err();
        assert_eq!(e.kind, ErrorKind::Eligibility);
        assert_eq!(seen.lock().unwrap().len(), 1, "it revalidated against a fresh catalogue");
        assert!(db.or_model("v/m:free").is_none());
        // a fresh catalogue is trusted without another download
        db.or_replace_catalog(&[normalize(&model("v/ok:free", zero()))], 1).unwrap();
        assert!(ensure_free(&db, &OpenRouter::with(&base, None), "v/ok:free").is_ok());
        assert_eq!(seen.lock().unwrap().len(), 1);
        // ids without :free never reach the network at all
        assert_eq!(ensure_free(&db, &OpenRouter::with(&base, None), "v/ok").unwrap_err().kind, ErrorKind::Eligibility);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn requests_for_paid_or_routed_models_are_never_sent() {
        let (base, seen) = mock(vec![]);
        let c = OpenRouter::with(&base, Some(FAKE_KEY));
        for m in ["openai/gpt-4o", "openrouter/auto", "openrouter/free", "a/b:free,c/d", "a/b :free", "a/b:free:nitro", "a/b:floor"] {
            let r = c.stream(&ChatRequest { model: m.into(), system: None, messages: vec![("user".into(), "hi".into())], max_tokens: None }, &AtomicBool::new(false), &mut |_| {});
            // `a/b:free:nitro` ends with `nitro`, so it is rejected too; only a literal `:free` suffix passes the guard
            assert_eq!(r.err().map(|e| e.kind), Some(ErrorKind::Eligibility), "{m}");
        }
        assert!(seen.lock().unwrap().is_empty(), "nothing reached the network");
    }

    #[test]
    fn a_free_request_names_exactly_one_model_and_streams_the_answer() {
        let body = sse(&[
            r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"{"choices":[{"delta":{"content":"lo **world**"}}]}"#,
            r#"{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13,"cost":0}}"#,
            "[DONE]",
        ]);
        let body = format!(": OPENROUTER PROCESSING\n\n{body}");
        let (base, seen) = mock(vec![("/chat/completions", 200, "text/event-stream", body)]);
        let c = OpenRouter::with(&base, Some(FAKE_KEY));
        let mut parts: Vec<String> = Vec::new();
        let out = c
            .stream(&ChatRequest { model: "meta/m:free".into(), system: Some("be brief".into()), messages: vec![("user".into(), "hi".into())], max_tokens: Some(50) }, &AtomicBool::new(false), &mut |d| parts.push(d.into()))
            .unwrap();
        assert_eq!(parts, vec!["Hel", "lo **world**"]);
        assert_eq!(out.text, "Hello **world**");
        let u = out.usage.unwrap();
        assert_eq!((u.prompt_tokens, u.completion_tokens, u.total_tokens, u.cost), (Some(9), Some(4), Some(13), Some(0.0)));
        let req = seen.lock().unwrap()[0].clone();
        assert!(req.to_lowercase().contains(&format!("authorization: bearer {FAKE_KEY}").to_lowercase()));
        let json_body: Value = serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(json_body["model"], "meta/m:free");
        assert_eq!(json_body["stream"], true);
        assert_eq!(json_body["provider"]["allow_fallbacks"], false);
        assert!(json_body.get("models").is_none() && json_body.get("route").is_none(), "no fallback list");
        assert_eq!(json_body["messages"][0]["role"], "system");
        assert_eq!(json_body["max_tokens"], 50);
    }

    #[test]
    fn api_errors_are_explained_and_never_contain_the_key() {
        for (status, kind) in [(401u16, ErrorKind::AuthExpired), (402, ErrorKind::Eligibility), (404, ErrorKind::NotFound), (429, ErrorKind::UsageLimit), (502, ErrorKind::Network)] {
            let body = json!({"error": {"message": format!("boom {FAKE_KEY} boom"), "code": status}}).to_string();
            let (base, _) = mock(vec![("/chat/completions", status, "application/json", body)]);
            let e = OpenRouter::with(&base, Some(FAKE_KEY))
                .stream(&ChatRequest { model: "a/b:free".into(), system: None, messages: vec![("user".into(), "x".into())], max_tokens: None }, &AtomicBool::new(false), &mut |_| {})
                .err()
                .unwrap();
            assert_eq!(e.kind, kind, "{status}");
            assert!(!e.message.contains(FAKE_KEY) && !e.message.contains("sk-or-v1"), "{status}: {}", e.message);
        }
        // a 402 must say that nothing was charged and that no paid model was tried
        let (base, _) = mock(vec![("/chat/completions", 402, "application/json", "{}".into())]);
        let e = OpenRouter::with(&base, Some(FAKE_KEY)).stream(&ChatRequest { model: "a/b:free".into(), system: None, messages: vec![("user".into(), "x".into())], max_tokens: None }, &AtomicBool::new(false), &mut |_| {}).err().unwrap();
        assert!(e.message.contains("only uses free models"));
    }

    #[test]
    fn errors_inside_a_200_stream_are_reported_and_partial_text_is_kept_by_the_caller() {
        let body = sse(&[r#"{"choices":[{"delta":{"content":"par"}}]}"#, r#"{"error":{"code":429,"message":"slow down"}}"#]);
        let (base, _) = mock(vec![("/chat/completions", 200, "text/event-stream", body)]);
        let mut got = String::new();
        let e = OpenRouter::with(&base, Some(FAKE_KEY))
            .stream(&ChatRequest { model: "a/b:free".into(), system: None, messages: vec![("user".into(), "x".into())], max_tokens: None }, &AtomicBool::new(false), &mut |d| got.push_str(d))
            .err()
            .unwrap();
        assert_eq!((e.kind, got.as_str()), (ErrorKind::UsageLimit, "par"));
        // a stream that just stops is an interruption, not a success
        let (base, _) = mock(vec![("/chat/completions", 200, "text/event-stream", sse(&[r#"{"choices":[{"delta":{"content":"x"}}]}"#]))]);
        let e = OpenRouter::with(&base, Some(FAKE_KEY)).stream(&ChatRequest { model: "a/b:free".into(), system: None, messages: vec![("user".into(), "x".into())], max_tokens: None }, &AtomicBool::new(false), &mut |_| {}).err().unwrap();
        assert_eq!(e.kind, ErrorKind::Network);
    }

    #[test]
    fn a_cancelled_request_stops_without_reading() {
        let (base, _) = mock(vec![("/chat/completions", 200, "text/event-stream", sse(&[r#"{"choices":[{"delta":{"content":"x"}}]}"#, "[DONE]"]))]);
        let cancel = AtomicBool::new(true);
        let e = OpenRouter::with(&base, Some(FAKE_KEY)).stream(&ChatRequest { model: "a/b:free".into(), system: None, messages: vec![("user".into(), "x".into())], max_tokens: None }, &cancel, &mut |_| {}).err().unwrap();
        assert_eq!(e.kind, ErrorKind::Cancelled);
    }

    #[test]
    fn the_key_check_does_not_forward_the_masked_key_label() {
        let body = json!({"data": {"label": "sk-or-v1-abc...xyz", "is_free_tier": true, "limit_remaining": 7.5}}).to_string();
        let (base, seen) = mock(vec![("/key", 200, "application/json", body)]);
        let info = OpenRouter::with(&base, Some(FAKE_KEY)).check_key().unwrap();
        assert!(info.free_tier);
        assert_eq!(info.limit_remaining, Some(7.5));
        assert!(!serde_json::to_string(&info).unwrap().contains("sk-or"));
        assert!(seen.lock().unwrap()[0].to_lowercase().contains("authorization: bearer"));
        let (bad, _) = mock(vec![("/key", 401, "application/json", r#"{"error":{"message":"No auth credentials found"}}"#.into())]);
        assert_eq!(OpenRouter::with(&bad, Some(FAKE_KEY)).check_key().err().unwrap().kind, ErrorKind::AuthExpired);
        assert_eq!(OpenRouter::with(&bad, None).check_key().err().unwrap().kind, ErrorKind::NotConnected);
    }

    #[test]
    fn the_public_model_list_is_fetched_without_the_key() {
        let (base, seen) = mock(vec![("/models", 200, "application/json", json!({"data": [model("a/b:free", zero())]}).to_string())]);
        OpenRouter::with(&base, Some(FAKE_KEY)).models().unwrap();
        assert!(!seen.lock().unwrap()[0].to_lowercase().contains("authorization"), "the catalogue endpoint is public");
    }

    #[test]
    fn scrub_removes_the_exact_key_and_key_shaped_strings() {
        let s = scrub(&format!("failed with {FAKE_KEY} and sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa"), Some(FAKE_KEY));
        assert!(!s.contains("sk-or") && !s.contains(FAKE_KEY), "{s}");
    }
}
