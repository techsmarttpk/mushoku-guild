//! The Guild roster: recruited OpenRouter models, each of which is a character in the café.
//!
//! Rules enforced here: a model can only be recruited if it is verifiably free right now; a recruited model whose
//! eligibility lapses becomes *unavailable* (its character and conversations stay, new requests are refused with the
//! reason); removing a model only retires the character (`active = 0`) and never touches conversation history;
//! recruiting it again brings back the same character (the appearance seed is kept).
use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::db::{now_ms, Db};
use crate::events::{ErrorKind, ProviderError};
use crate::openrouter::{ensure_free, OpenRouter, OrModel};
use crate::provider::Capabilities;
use crate::secrets;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GuildMember {
    pub id: i64,
    pub provider: String,
    pub model_id: String,
    pub name: String,
    pub vendor: String,
    pub seed: i64,
    /// available | unavailable
    pub status: String,
    pub reason: String,
    pub context_length: Option<i64>,
    pub description: String,
    pub caps: Capabilities,
    pub recruited_at: i64,
    /// whether the provider key is stored right now (a character is "offline" without it)
    pub connected: bool,
}

const COLS: &str = "id,provider,model_id,name,vendor,seed,status,reason,context_length,description,caps,recruited_at";

fn member_row(r: &rusqlite::Row) -> rusqlite::Result<GuildMember> {
    Ok(GuildMember {
        id: r.get(0)?,
        provider: r.get(1)?,
        model_id: r.get(2)?,
        name: r.get(3)?,
        vendor: r.get(4)?,
        seed: r.get(5)?,
        status: r.get(6)?,
        reason: r.get(7)?,
        context_length: r.get(8)?,
        description: r.get(9)?,
        caps: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
        recruited_at: r.get(11)?,
        connected: false,
    })
}

impl Db {
    /// Active members in recruitment order.
    pub fn guild_list(&self) -> Vec<GuildMember> {
        let c = self.c();
        let mut st = c.prepare(&format!("SELECT {COLS} FROM guild_models WHERE active=1 ORDER BY recruited_at, id")).expect("sql");
        st.query_map([], member_row).map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn guild_by_model(&self, provider: &str, model_id: &str) -> Option<(GuildMember, bool)> {
        self.c()
            .query_row(&format!("SELECT {COLS},active FROM guild_models WHERE provider=?1 AND model_id=?2"), params![provider, model_id], |r| Ok((member_row(r)?, r.get::<_, i64>(12)? == 1)))
            .optional()
            .ok()
            .flatten()
    }

    pub fn guild_recruit(&self, m: &OrModel, seed: u32) -> Result<GuildMember, String> {
        let caps = serde_json::to_string(&m.caps).unwrap_or_else(|_| "{}".into());
        {
            let c = self.c();
            // Re-recruiting a retired model brings back the same character: the seed is not overwritten.
            c.execute(
                "INSERT INTO guild_models(provider,model_id,name,vendor,seed,status,reason,context_length,description,caps,active,recruited_at)
                 VALUES('openrouter',?1,?2,?3,?4,'available','',?5,?6,?7,1,?8)
                 ON CONFLICT(provider,model_id) DO UPDATE SET active=1, status='available', reason='', name=excluded.name, vendor=excluded.vendor,
                   context_length=excluded.context_length, description=excluded.description, caps=excluded.caps,
                   recruited_at=CASE WHEN guild_models.active=1 THEN guild_models.recruited_at ELSE excluded.recruited_at END",
                params![m.id, m.name, m.vendor, seed as i64, m.context_length, m.description, caps, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }
        self.guild_by_model("openrouter", &m.id).map(|(g, _)| g).ok_or_else(|| "the model could not be recruited".to_string())
    }

    /// Retires the character. Conversations that used the model are untouched.
    pub fn guild_remove(&self, id: i64) -> bool {
        self.c().execute("UPDATE guild_models SET active=0 WHERE id=?1 AND active=1", [id]).map(|n| n > 0).unwrap_or(false)
    }

    /// Re-evaluates every active member against a freshly downloaded catalogue (id -> eligible metadata, or why not).
    pub fn guild_apply_catalog(&self, verdicts: &HashMap<String, Result<OrModel, String>>) {
        for g in self.guild_list() {
            let c = self.c();
            match verdicts.get(&g.model_id) {
                Some(Ok(m)) => {
                    let caps = serde_json::to_string(&m.caps).unwrap_or_else(|_| "{}".into());
                    let _ = c.execute("UPDATE guild_models SET status='available', reason='', name=?2, vendor=?3, context_length=?4, description=?5, caps=?6 WHERE id=?1", params![g.id, m.name, m.vendor, m.context_length, m.description, caps]);
                }
                Some(Err(why)) => {
                    let _ = c.execute("UPDATE guild_models SET status='unavailable', reason=?2 WHERE id=?1", params![g.id, format!("OpenRouter no longer lists it as free: {why}.")]);
                }
                None => {
                    let _ = c.execute("UPDATE guild_models SET status='unavailable', reason='OpenRouter no longer lists this model.' WHERE id=?1", [g.id]);
                }
            }
        }
    }
}

fn with_connection(mut v: Vec<GuildMember>) -> Vec<GuildMember> {
    let connected = secrets::load("openrouter_api_key").is_some();
    for m in &mut v {
        m.connected = connected;
    }
    v
}

fn err(kind: ErrorKind, m: impl Into<String>) -> ProviderError {
    ProviderError::new(kind, m)
}

#[tauri::command]
pub fn guild_list(state: State<'_, AppState>) -> Vec<GuildMember> {
    with_connection(state.db.guild_list())
}

/// Recruits a model. It is re-validated against a fresh catalogue first, so a model that just stopped being free cannot be added.
#[tauri::command]
pub async fn guild_recruit(state: State<'_, AppState>, model_id: String, seed: u32) -> Result<Vec<GuildMember>, ProviderError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = OpenRouter::live();
        let m = ensure_free(&db, &client, &model_id)?;
        db.guild_recruit(&m, seed).map_err(|e| err(ErrorKind::Other, e))?;
        Ok(with_connection(db.guild_list()))
    })
    .await
    .map_err(|e| err(ErrorKind::Other, e.to_string()))?
}

#[tauri::command]
pub fn guild_remove(state: State<'_, AppState>, id: i64) -> Vec<GuildMember> {
    state.db.guild_remove(id);
    with_connection(state.db.guild_list())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str) -> OrModel {
        OrModel {
            id: id.into(),
            name: format!("Name of {id}"),
            vendor: "v".into(),
            context_length: Some(8192),
            description: "d".into(),
            input_modalities: vec!["text".into()],
            output_modalities: vec!["text".into()],
            caps: Capabilities { text_input: true, text_output: true, streaming: true, ..Default::default() },
        }
    }

    #[test]
    fn recruiting_persists_the_roster_in_order_with_the_character_seed() {
        let db = Db::open_in_memory();
        let a = db.guild_recruit(&m("v/a:free"), 111).unwrap();
        let b = db.guild_recruit(&m("v/b:free"), 222).unwrap();
        let roster = db.guild_list();
        assert_eq!(roster.iter().map(|x| x.model_id.as_str()).collect::<Vec<_>>(), ["v/a:free", "v/b:free"]);
        assert_eq!((a.seed, b.seed), (111, 222));
        assert!(roster.iter().all(|x| x.status == "available" && x.provider == "openrouter"));
        // recruiting the same model twice never creates a second character
        db.guild_recruit(&m("v/a:free"), 999).unwrap();
        assert_eq!(db.guild_list().len(), 2);
        assert_eq!(db.guild_by_model("openrouter", "v/a:free").unwrap().0.seed, 111, "the character keeps its look");
    }

    #[test]
    fn removal_retires_the_character_but_keeps_conversations_and_a_later_return_restores_it() {
        let db = Db::open_in_memory();
        let g = db.guild_recruit(&m("v/a:free"), 5).unwrap();
        let conv = db.uchat_create("openrouter", "v/a:free").unwrap();
        db.uchat_add(conv.id, "user", "remember me", "complete").unwrap();
        db.uchat_add(conv.id, "assistant", "I will", "complete").unwrap();
        assert!(db.guild_remove(g.id));
        assert!(db.guild_list().is_empty());
        assert_eq!(db.uchat_list("remember me").len(), 1, "history survives removal");
        assert_eq!(db.uchat_recent(conv.id, 10).len(), 2);
        assert_eq!(db.uchat_conv(conv.id).unwrap().model, "v/a:free");
        assert!(!db.guild_remove(g.id), "removing twice does nothing");
        let back = db.guild_recruit(&m("v/a:free"), 777).unwrap();
        assert_eq!((back.id, back.seed), (g.id, 5), "same character returns");
        assert_eq!(db.guild_list().len(), 1);
    }

    #[test]
    fn a_model_that_stops_being_free_or_disappears_is_marked_unavailable_with_a_reason() {
        let db = Db::open_in_memory();
        db.guild_recruit(&m("v/paid-now:free"), 1).unwrap();
        db.guild_recruit(&m("v/gone:free"), 2).unwrap();
        db.guild_recruit(&m("v/fine:free"), 3).unwrap();
        let mut verdicts: HashMap<String, Result<OrModel, String>> = HashMap::new();
        verdicts.insert("v/paid-now:free".into(), Err("the `completion` price is not zero".into()));
        verdicts.insert("v/fine:free".into(), Ok(m("v/fine:free")));
        db.guild_apply_catalog(&verdicts);
        let by = |id: &str| db.guild_by_model("openrouter", id).unwrap().0;
        assert_eq!(by("v/paid-now:free").status, "unavailable");
        assert!(by("v/paid-now:free").reason.contains("completion"));
        assert_eq!(by("v/gone:free").status, "unavailable");
        assert!(by("v/gone:free").reason.contains("no longer lists"));
        assert_eq!(by("v/fine:free").status, "available");
        assert_eq!(db.guild_list().len(), 3, "characters and their histories stay");
        // it can come back when it is free again
        verdicts.insert("v/gone:free".into(), Ok(m("v/gone:free")));
        db.guild_apply_catalog(&verdicts);
        assert_eq!(by("v/gone:free").status, "available");
    }

    #[test]
    fn existing_conversations_survive_the_migration_that_adds_openrouter() {
        // Build a database at schema version 5 (before this cycle), fill it, then let the real migrations run.
        let dir = std::env::temp_dir().join(format!("mg-mig-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            conn.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);").unwrap();
            let sqls = crate::db::migrations_for_test();
            for (i, sql) in sqls.iter().take(5).enumerate() {
                conn.execute_batch(sql).unwrap();
                conn.execute("INSERT INTO schema_migrations VALUES (?1, 0)", [i as i64 + 1]).unwrap();
            }
            conn.execute("INSERT INTO uchat_conversations(id,title,provider,model,created_at,updated_at) VALUES (7,'Old chat','claude','sonnet',1,2),(8,'GPT chat','chatgpt','gpt-x',3,4)", []).unwrap();
            conn.execute("INSERT INTO uchat_messages(conversation_id,role,body,status,created_at) VALUES (7,'user','hello','complete',1),(7,'assistant','hi','complete',2),(8,'user','yo','complete',3)", []).unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(db.uchat_list("").len(), 2);
        assert_eq!(db.uchat_recent(7, 10).len(), 2);
        assert_eq!(db.uchat_conv(8).unwrap().provider, "chatgpt");
        // the rebuilt tables accept the new provider, keep ids moving forward and still cascade-delete messages
        let n = db.uchat_create("openrouter", "v/a:free").unwrap();
        assert!(n.id > 8);
        db.uchat_add(n.id, "user", "x", "complete").unwrap();
        db.uchat_delete(n.id);
        let orphans: i64 = db.c().query_row("SELECT COUNT(*) FROM uchat_messages WHERE conversation_id=?1", [n.id], |r| r.get(0)).unwrap();
        assert_eq!(orphans, 0);
        assert!(db.uchat_create("bard", "").is_err(), "unknown providers are still refused");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
