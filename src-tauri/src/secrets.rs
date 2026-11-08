//! Windows Credential Manager storage (via `keyring`). Secrets never go to SQLite, logs or events.
//! A credential blob is limited to about 2.5 KB, so values are stored in chunks.
use keyring::Entry;

const SERVICE: &str = "Mushoku Guild";
const CHUNK: usize = 1800;
const MAX_CHUNKS: usize = 8;

fn entry(name: &str, i: usize) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{name}#{i}")).map_err(|e| format!("credential store unavailable: {e}"))
}

pub fn save(name: &str, value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() > CHUNK * MAX_CHUNKS {
        return Err("secret too large for the credential store".into());
    }
    let chunks: Vec<&[u8]> = bytes.chunks(CHUNK).collect();
    for (i, c) in chunks.iter().enumerate() {
        entry(name, i)?.set_secret(c).map_err(|e| format!("could not save credential: {e}"))?;
    }
    // Remove stale trailing chunks from a previous, longer value.
    for i in chunks.len()..MAX_CHUNKS {
        match entry(name, i)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("could not clean credential: {e}")),
        }
    }
    Ok(())
}

pub fn load(name: &str) -> Option<String> {
    let mut out = Vec::new();
    for i in 0..MAX_CHUNKS {
        match entry(name, i).ok()?.get_secret() {
            Ok(b) => out.extend(b),
            Err(_) => break,
        }
    }
    if out.is_empty() {
        None
    } else {
        String::from_utf8(out).ok()
    }
}

pub fn delete(name: &str) {
    for i in 0..MAX_CHUNKS {
        if let Ok(e) = entry(name, i) {
            let _ = e.delete_credential();
        }
    }
}
