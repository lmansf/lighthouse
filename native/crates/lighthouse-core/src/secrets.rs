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
//! created 0600 on first use). Both engines (Rust + the TS twin) use the same
//! iv|tag|ct sealed layout so a `secrets.json` stays token-compatible across
//! them.
//!
//! Threat model, honestly: by default the sealing secret sits beside the
//! ciphertext (a 0600 `secret.key`), so this protects against casual disk/
//! backup/cloud-sync inspection — not against malware running as the user. That
//! matches the app's posture for connector OAuth tokens.
//!
//! OS-keychain upgrade (P1.4): build with `--features keychain` and the sealing
//! secret moves into the platform keychain (macOS Keychain / Windows Credential
//! Manager / Linux Secret Service) instead of the file — so it is no longer
//! stored next to the ciphertext it seals. The file path stays as a fail-closed
//! fallback for environments with no keychain (headless servers, CI, the TS dev
//! twin, Linux without a Secret Service). Off by default because it can't be
//! verified from the dev container; the maintainer enables it after testing on
//! real targets (see docs and the `keychain` feature in Cargo.toml).

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

/// Derive a purpose-scoped 32-byte key from the per-install machine secret,
/// domain-separated by `label` (SHA-256 over `label | secret`). Lets other
/// subsystems (the audit-log HMAC chain) key off the same install secret
/// without ever sharing the sealing key. Stable across launches.
pub fn derived_key(label: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(label.as_bytes());
    h.update(b"|");
    h.update(machine_secret().as_bytes());
    h.finalize().into()
}

/// Keychain coordinates for the sealing secret (only used with the `keychain`
/// feature). Versioned so a future key-rotation can migrate cleanly.
#[cfg(feature = "keychain")]
const KEYCHAIN_SERVICE: &str = "com.lighthouse.app";
#[cfg(feature = "keychain")]
const KEYCHAIN_ACCOUNT: &str = "sealing-key-v1";

/// Best-effort read of the sealing secret from the OS keychain. `None` on any
/// error, when absent, or when the `keychain` feature is off — the caller then
/// falls back to the on-disk secret.
#[cfg(feature = "keychain")]
fn keychain_get() -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}
#[cfg(not(feature = "keychain"))]
fn keychain_get() -> Option<String> {
    None
}

/// Best-effort store of the sealing secret in the OS keychain. Returns whether
/// it stuck (false when the feature is off or no keychain is available).
#[cfg(feature = "keychain")]
fn keychain_set(secret: &str) -> bool {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .and_then(|e| e.set_password(secret))
        .is_ok()
}
#[cfg(not(feature = "keychain"))]
fn keychain_set(_secret: &str) -> bool {
    false
}

/// The per-install sealing secret: 32 random bytes, base64, created once.
/// Resolution order: OS keychain (when built with `--features keychain`) →
/// legacy 0600 `secret.key` → freshly generated. With the keychain available a
/// fresh secret lives ONLY in the keychain (not beside the ciphertext); without
/// it, `write_json` gives the 0600 + atomic-rename fallback for free.
fn machine_secret() -> String {
    // 1. Prefer the OS keychain — the secret then lives outside the app-state
    //    dir, not next to the ciphertext it seals.
    if let Some(s) = keychain_get() {
        return s;
    }
    let f = secret_file();
    // 2. Legacy / fallback: the on-disk secret. If present, best-effort promote
    //    it into the keychain (the file stays for the dev twin + keychain-less
    //    environments, and so existing sealed keys keep decrypting).
    if let Some(s) = read_json::<Option<String>>(&f, None).filter(|s| !s.is_empty()) {
        keychain_set(&s);
        return s;
    }
    // 3. Fresh install: generate once. Keychain-only when available; else the
    //    0600 file so keys can still be sealed.
    let mut raw = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut raw);
    let s = base64::engine::general_purpose::STANDARD.encode(raw);
    if !keychain_set(&s) {
        write_json(&f, &s);
    }
    s
}

fn sealing_key() -> [u8; 32] {
    let secret = machine_secret();
    let mut key = [0u8; 32];
    // Node's scryptSync defaults (matched by the TS twin): N=16384, r=8, p=1.
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
