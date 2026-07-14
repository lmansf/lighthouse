//! Install-global encrypted store for provider API keys (port twin:
//! `src/server/secrets.ts` — KEEP IN SYNC, the two engines read the same
//! files).
//!
//! Keys used to live as plaintext inside `profile.json`, which (a) was wiped
//! by sign-out, (b) rode along into cloud-synced vault backups in older
//! layouts, and (c) sat readable on disk. They now live here: one
//! `secrets.json` in the install-global app state dir (see
//! `config::app_state_dir` — survives vault switches and sign-out), each key
//! sealed with AES-256-GCM under a per-install random secret (`secret.key`,
//! created 0600 on first use). Same iv|tag|ct sealed layout as the license
//! module so both engines stay token-compatible.
//!
//! Threat model, honestly: the sealing secret sits beside the ciphertext, so
//! this protects against casual disk/backup/cloud-sync inspection — not
//! against malware running as the user. That matches the app's posture for
//! connector OAuth tokens; an OS-keychain upgrade can slot in behind this API
//! later without changing callers.

use std::collections::HashMap;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::config::{app_state_dir, read_json, write_json};

fn secrets_path() -> PathBuf {
    app_state_dir().join("secrets.json")
}

fn secret_file() -> PathBuf {
    app_state_dir().join("secret.key")
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretsFile {
    #[serde(default)]
    v: u32,
    /// provider-id → base64(iv | tag | ciphertext) of the raw key string.
    #[serde(default)]
    keys: HashMap<String, String>,
}

/// The per-install sealing secret: 32 random bytes, base64 on disk, created
/// once. `write_json` gives the 0600 + atomic-rename treatment for free (the
/// base64 string is stored as a JSON string).
fn machine_secret() -> String {
    let f = secret_file();
    if let Some(s) = read_json::<Option<String>>(&f, None).filter(|s| !s.is_empty()) {
        return s;
    }
    let mut raw = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut raw);
    let s = base64::engine::general_purpose::STANDARD.encode(raw);
    write_json(&f, &s);
    s
}

fn sealing_key() -> [u8; 32] {
    let secret = machine_secret();
    let mut key = [0u8; 32];
    // Node's scryptSync defaults, same as the license module: N=16384, r=8, p=1.
    let params = scrypt::Params::new(14, 8, 1, 32).expect("static scrypt params");
    scrypt::scrypt(
        secret.as_bytes(),
        b"lighthouse-secrets-v1",
        &params,
        &mut key,
    )
    .expect("scrypt derivation");
    key
}

fn seal(plaintext: &str) -> String {
    let cipher = Aes256Gcm::new_from_slice(&sealing_key()).expect("32-byte key");
    let mut iv = [0u8; 12];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut iv);
    let sealed = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
        .unwrap_or_default();
    // aes-gcm appends the 16-byte tag to the ciphertext; Node's layout is
    // iv | tag | ciphertext — reorder to stay compatible with the TS twin.
    let (ct, tag) = sealed.split_at(sealed.len().saturating_sub(16));
    let mut out = Vec::with_capacity(12 + 16 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(tag);
    out.extend_from_slice(ct);
    base64::engine::general_purpose::STANDARD.encode(out)
}

fn open(token: &str) -> Option<String> {
    let buf = base64::engine::general_purpose::STANDARD
        .decode(token)
        .ok()?;
    if buf.len() < 28 {
        return None;
    }
    let (iv, rest) = buf.split_at(12);
    let (tag, ct) = rest.split_at(16);
    let mut sealed = Vec::with_capacity(ct.len() + 16);
    sealed.extend_from_slice(ct);
    sealed.extend_from_slice(tag);
    let cipher = Aes256Gcm::new_from_slice(&sealing_key()).ok()?;
    let plain = cipher
        .decrypt(Nonce::from_slice(iv), sealed.as_ref())
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Store (or, with an empty key, remove) a provider's API key. Plaintext never
/// touches disk; a garbled store entry simply reads back as unkeyed.
pub fn set_provider_key(provider_id: &str, key: &str) {
    let mut f: SecretsFile = read_json(&secrets_path(), SecretsFile::default());
    f.v = 1;
    let key = key.trim();
    if key.is_empty() {
        f.keys.remove(provider_id);
    } else {
        f.keys.insert(provider_id.to_string(), seal(key));
    }
    write_json(&secrets_path(), &f);
}

/// The stored key for a provider, if one is saved and intact.
pub fn get_provider_key(provider_id: &str) -> Option<String> {
    let f: SecretsFile = read_json(&secrets_path(), SecretsFile::default());
    f.keys
        .get(provider_id)
        .and_then(|token| open(token))
        .filter(|k| !k.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Env-var mutation is process-global; run these in one test to avoid
    // cross-test races (the suite runs threads in parallel).
    #[test]
    fn roundtrip_remove_and_tamper() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", dir.path());

        // Roundtrip.
        set_provider_key("openai", "sk-test-123");
        assert_eq!(get_provider_key("openai").as_deref(), Some("sk-test-123"));
        // The plaintext must not appear anywhere in the store file.
        let raw = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
        assert!(!raw.contains("sk-test-123"), "key stored in plaintext");

        // Unknown provider / empty store entry.
        assert_eq!(get_provider_key("google"), None);

        // Overwrite, then remove via empty key.
        set_provider_key("openai", "sk-test-456");
        assert_eq!(get_provider_key("openai").as_deref(), Some("sk-test-456"));
        set_provider_key("openai", "  ");
        assert_eq!(get_provider_key("openai"), None);

        // Tampered token reads back as unkeyed, never panics.
        set_provider_key("xai", "sk-x");
        let mut f: SecretsFile = read_json(&secrets_path(), SecretsFile::default());
        f.keys.insert("xai".into(), "not-base64!!".into());
        write_json(&secrets_path(), &f);
        assert_eq!(get_provider_key("xai"), None);

        std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
        let _ = std::fs::remove_dir_all(dir.path());
    }
}
