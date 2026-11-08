//! `mushoku-guild.exe --mcp-approver`: a minimal stdio MCP server that Claude Code starts (via the per-run
//! `--mcp-config`) so that `--permission-prompt-tool mcp__mushoku__approve` can ask the user. It holds no
//! authority: it forwards each request over loopback to the running app (with a per-run secret) and relays the
//! user's decision. On any failure it answers "deny" (default deny).
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};

fn ask_app(addr: &str, token: &str, args: &Value) -> Value {
    let deny = |m: &str| json!({"behavior": "deny", "message": m});
    let Ok(mut s) = TcpStream::connect(addr) else { return deny("Mushoku Guild is not reachable; denied.") };
    let req = json!({"token": token, "tool_name": args["tool_name"], "input": args["input"], "tool_use_id": args["tool_use_id"]});
    if s.write_all(format!("{req}\n").as_bytes()).is_err() {
        return deny("Could not send the request to Mushoku Guild; denied.");
    }
    let _ = s.set_read_timeout(Some(Duration::from_secs(660)));
    let mut line = String::new();
    match BufReader::new(s).read_line(&mut line) {
        Ok(n) if n > 0 => serde_json::from_str(line.trim()).unwrap_or_else(|_| deny("Unreadable answer from Mushoku Guild; denied.")),
        _ => deny("No answer from Mushoku Guild; denied."),
    }
}

pub fn run() {
    let addr = std::env::var("MUSHOKU_APPROVER_ADDR").unwrap_or_default();
    let token = std::env::var("MUSHOKU_APPROVER_TOKEN").unwrap_or_default();
    let out = std::io::stdout();
    let send = |v: Value| {
        let mut o = out.lock();
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
        let id = m["id"].clone();
        match m["method"].as_str().unwrap_or("") {
            "initialize" => send(json!({"jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": m["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "mushoku", "version": env!("CARGO_PKG_VERSION")}}})),
            "tools/list" => send(json!({"jsonrpc": "2.0", "id": id, "result": {"tools": [{
                "name": "approve", "description": "Asks the Mushoku Guild user whether Claude Code may run a tool.",
                "inputSchema": {"type": "object", "properties": {"tool_name": {"type": "string"}, "input": {"type": "object"}, "tool_use_id": {"type": "string"}}, "required": ["tool_name", "input"]}}]}})),
            "tools/call" => {
                let decision = ask_app(&addr, &token, &m["params"]["arguments"]);
                send(json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": decision.to_string()}]}}));
            }
            "ping" => send(json!({"jsonrpc": "2.0", "id": id, "result": {}})),
            _ if !id.is_null() => send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}})),
            _ => {}
        }
    }
}
