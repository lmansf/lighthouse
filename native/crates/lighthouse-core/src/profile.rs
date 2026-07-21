//! Local profile + onboarding state, persisted to `profile.json` (port of
//! `src/server/profile.ts`). Single-user standalone: "auth" is a
//! locally-stored profile plus the chosen model provider/key. Provider API
//! keys are persisted separately in the encrypted install-global secrets
//! store (crate::secrets) — they survive sign-out and vault switches, never
//! leave the machine, and are never returned to the client (only `hasApiKey`
//! / `keyedProviders`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::config::{profile_path, read_json, write_json};
use crate::contracts::User;
use crate::llm::ModelCfg;

const LOCAL_PROVIDER_ID: &str = "local";
const LOCAL_MODEL_ID: &str = "lighthouse-local";

/// Default-inclusion behavior for newly-added files when the user has made no
/// explicit onboarding choice. The A/B experiment that used to pick this was
/// removed with all ambient data collection; the engine now uses a single
/// privacy-preserving default: nothing is searchable until the user includes
/// it. PARITY: keep in lockstep with the TS `effectiveDefaultInclusion`
/// fallback in `src/server/profile.ts`.
const DEFAULT_INCLUSION_FALLBACK: &str = "exclude";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    #[serde(default = "default_step")]
    step: String,
    #[serde(default)]
    user: Option<User>,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    has_api_key: bool,
    /// LEGACY, read-only: single plaintext key slot from the one-provider
    /// (Anthropic) era. Migrated into the encrypted secrets store on load and
    /// stripped from disk; never written non-empty again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    /// LEGACY, read-only: the pre-0.11 plaintext per-provider key map.
    /// Migrated into the encrypted install-global secrets store
    /// (crate::secrets) on load and stripped from disk. Keys are surfaced to
    /// the client solely as `hasApiKey` + `keyedProviders`, never raw.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    api_keys: HashMap<String, String>,
    /// Whether the user has ever explicitly saved a model choice (server-only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_ever_selected: Option<bool>,
    /// The user's explicit default-inclusion choice ("include"/"exclude"), if
    /// made during onboarding. Absent ⇒ fall back to DEFAULT_INCLUSION_FALLBACK.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_inclusion_choice: Option<String>,
}

fn default_step() -> String {
    "vault".to_string()
}

impl Default for StoredProfile {
    fn default() -> Self {
        StoredProfile {
            step: default_step(),
            user: None,
            provider_id: None,
            model_id: None,
            has_api_key: false,
            api_key: None,
            api_keys: HashMap::new(),
            model_ever_selected: None,
            default_inclusion_choice: None,
        }
    }
}

/// Provider ids the app can actually answer with (mirrors the TS server's
/// knownProviderIds): local, Anthropic, and every wired OpenAI-compatible
/// vendor — derived from the engine's own table so the two can't drift. A
/// profile carrying anything else (a provider from a build that listed more
/// than it wired, or a removed one) is normalized to the private local
/// default, so the UI never claims excerpts go to a provider that is never
/// called. Stored keys are left untouched in case the provider returns.
fn is_known_provider(id: &str) -> bool {
    id == LOCAL_PROVIDER_ID || id == "anthropic" || crate::llm::remote_provider(id).is_some()
}

/// §3 / add-mobile-local-inference: what a profile is normalized TO when its
/// stored provider can't answer here — pure for tests. The desktop keeps the
/// historic private-local default; a mobile shell with a usable on-device backend
/// (`on_device_backend`) ALSO defaults to the private model (zero-setup, fully
/// private); a mobile shell WITHOUT one gets NO provider at all — deterministic
/// asks still answer (origin "device"), and the first saved cloud key becomes the
/// selection via the ordinary select_model path. KEEP IN SYNC with
/// profile.ts::defaultProviderFor.
fn default_provider_for(platform_kind: &str, on_device_backend: bool) -> (Option<String>, Option<String>) {
    if crate::local_model::local_model_available(platform_kind, on_device_backend) {
        (
            Some(LOCAL_PROVIDER_ID.to_string()),
            Some(LOCAL_MODEL_ID.to_string()),
        )
    } else {
        (None, None)
    }
}

fn load() -> StoredProfile {
    let mut p: StoredProfile = read_json(&profile_path(), StoredProfile::default());
    let mut dirty = false;
    // Migrate the legacy single-key slot into the per-provider map. It can
    // only be an Anthropic key: every build that wrote it offered exactly one
    // keyed provider (openai/google/mistral appeared in an ancient picker but
    // were never wired, and their profiles were normalized to local).
    if p.api_keys.is_empty() {
        if let Some(k) = p.api_key.clone().filter(|k| !k.is_empty()) {
            p.api_keys.insert("anthropic".to_string(), k);
            dirty = true;
        }
    }
    // One-time migration: plaintext keys move out of profile.json into the
    // encrypted install-global secrets store (crate::secrets) and the
    // plaintext copies are stripped from disk. Existing sealed values win so
    // an old profile restored from backup can't clobber newer keys. After
    // this, profile.json never carries a raw key again (and sign-out — which
    // resets the profile — no longer discards them).
    if !p.api_keys.is_empty() {
        for (id, k) in p.api_keys.iter().filter(|(_, k)| !k.is_empty()) {
            if crate::secrets::get_provider_key(id).is_none() {
                crate::secrets::set_provider_key(id, k);
            }
        }
        p.api_keys.clear();
        p.api_key = None;
        dirty = true;
    }
    // Normalize a provider that can't answer HERE: one this build never wired
    // (see is_known_provider), or — §3 — "local" on a mobile shell, where the
    // private model is unsupported (a profile synced/copied from a desktop
    // install, or written pre-patch). Either way the fallback is platform-
    // aware: local on desktop, NO provider on mobile.
    let unusable = match p.provider_id.as_deref() {
        Some(id) if !is_known_provider(id) => true,
        Some(LOCAL_PROVIDER_ID) => !crate::local_model::supported_here(),
        _ => false,
    };
    if unusable {
        let (provider_id, model_id) = default_provider_for(
            crate::config::platform_kind(),
            crate::local_model::on_device_backend(),
        );
        p.provider_id = provider_id;
        p.model_id = model_id;
        dirty = true;
    }
    if dirty {
        save(&p);
    }
    p
}

fn save(p: &StoredProfile) {
    write_json(&profile_path(), p);
}

/// Public onboarding state — never includes the raw key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub step: String,
    pub user: Option<User>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub has_api_key: bool,
    /// Provider ids that have a usable key (stored or via env var) — never the
    /// keys themselves. Lets the UI say "key saved" per provider.
    pub keyed_providers: Vec<String>,
    /// The effective default-inclusion behavior ("include"/"exclude").
    pub default_inclusion: String,
}

/// The user's *effective* default-inclusion behavior: their explicit onboarding
/// choice if made, else the fixed privacy-preserving default (exclude). Single
/// source of truth for the vault engine and the UI. (The A/B variant that used
/// to decide the fallback was removed with all ambient data collection.)
pub fn effective_default_inclusion() -> String {
    match load().default_inclusion_choice.as_deref() {
        Some("include") => "include".to_string(),
        _ => DEFAULT_INCLUSION_FALLBACK.to_string(),
    }
}

/// Persist the user's explicit include/exclude-by-default choice.
pub fn set_default_inclusion(value: &str) {
    let mut p = load();
    p.default_inclusion_choice = Some(if value == "exclude" { "exclude" } else { "include" }.to_string());
    save(&p);
}

pub fn get_state() -> OnboardingState {
    let p = load();
    let keyed = keyed_providers(&p);
    // "Has a key" is now per-provider: true when the SELECTED provider has
    // one. The legacy stored flag only backs up pre-map anthropic profiles.
    let has_api_key = match p.provider_id.as_deref() {
        Some(id) if id != LOCAL_PROVIDER_ID => {
            keyed.iter().any(|k| k == id) || (id == "anthropic" && p.has_api_key)
        }
        _ => false,
    };
    OnboardingState {
        step: p.step,
        user: p.user,
        provider_id: p.provider_id,
        model_id: p.model_id,
        has_api_key,
        keyed_providers: keyed,
        default_inclusion: effective_default_inclusion(),
    }
}

/// Every keyed provider id with a usable key — stored in the map, in the
/// legacy slot (anthropic), or supplied via its env var.
fn keyed_providers(p: &StoredProfile) -> Vec<String> {
    let mut ids: Vec<&str> = vec!["anthropic"];
    ids.extend(crate::llm::OPENAI_COMPAT_PROVIDERS.iter().map(|r| r.id));
    ids.into_iter()
        .filter(|id| resolve_key(id, p).is_some())
        .map(String::from)
        .collect()
}

pub fn finish_vault() {
    // First run starts at the vault step (where the user's documents live).
    // Once acknowledged, advance to the interface-mode chooser (window vs
    // widget). The chooser is desktop-only; on the web twin the client
    // auto-advances past the mode step. PARITY: mirrors profile.ts finishVault.
    let mut p = load();
    p.step = "mode".to_string();
    save(&p);
}

pub fn finish_mode() {
    // The window/widget interface choice has been made (or auto-skipped on the
    // web twin); continue to the model picker. PARITY: profile.ts finishMode.
    let mut p = load();
    p.step = "select-model".to_string();
    save(&p);
}

pub fn select_model(provider_id: &str, model_id: &str, api_key: &str) {
    let p = load();
    // Managed policy: never persist (or seal a key for) a disallowed
    // provider. The op layers reject with a proper error before calling
    // here; this belt-and-braces leaves the profile unchanged for any
    // other caller. llm.rs additionally refuses at call time.
    if !crate::policy::provider_allowed(provider_id) {
        return;
    }
    let key = api_key.trim().to_string();
    // A pasted key is stored under the provider it was pasted FOR — sealed in
    // the install-global secrets store (crate::secrets), never in this file.
    // An empty field keeps that provider's existing key (switch model w/o
    // re-pasting).
    if !key.is_empty() && provider_id != LOCAL_PROVIDER_ID {
        crate::secrets::set_provider_key(provider_id, &key);
    }
    let next = StoredProfile {
        provider_id: Some(provider_id.to_string()),
        model_id: Some(model_id.to_string()),
        // Raw keys no longer live in profile.json (see load()'s migration);
        // the legacy fields stay declared read-only for old files.
        api_key: None,
        has_api_key: !key.is_empty() || p.has_api_key,
        api_keys: HashMap::new(),
        // The user picks their default-inclusion preference next (the final
        // step); complete_onboarding() lands on "done". PARITY: profile.ts
        // select_model.
        step: "inclusion".to_string(),
        model_ever_selected: Some(true),
        ..p.clone()
    };
    save(&next);
}

pub fn complete_onboarding() {
    let mut p = load();
    p.step = "done".to_string();
    save(&p);
}

pub fn sign_out() {
    // Resets identity/onboarding only. Provider API keys live in the
    // install-global secrets store and deliberately SURVIVE sign-out — they
    // are app credentials, not identity (pre-0.11 they sat in this file and
    // were silently discarded here, forcing a re-paste after every sign-out).
    save(&StoredProfile::default());
}

/// Resolved model config for the chat route: the SELECTED provider's key,
/// with its env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) taking precedence
/// over the stored one.
pub fn model_config() -> ModelCfg {
    let p = load();
    let api_key = p.provider_id.as_deref().and_then(|id| resolve_key(id, &p));
    ModelCfg {
        provider_id: p.provider_id,
        model_id: p.model_id,
        api_key,
    }
}

/// The local (on-device, key-less) model config — the exact shape
/// `model_config()` yields when the local provider is active. The
/// investigations local-only swap uses it at the ask chokepoint (openspec:
/// add-investigations); this module owns the sentinels, so the swap can never
/// drift from what selecting the private model produces. KEEP IN SYNC with
/// profile.ts::localModelConfig.
pub fn local_model_config() -> ModelCfg {
    ModelCfg {
        provider_id: Some(LOCAL_PROVIDER_ID.to_string()),
        model_id: Some(LOCAL_MODEL_ID.to_string()),
        api_key: None,
    }
}

/// The key a chat with `provider_id` would use right now (env → stored map →
/// legacy anthropic slot). None for local/unknown providers or when unkeyed.
pub fn resolved_key_for(provider_id: &str) -> Option<String> {
    resolve_key(provider_id, &load())
}

fn env_var_key(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

fn resolve_key(provider_id: &str, p: &StoredProfile) -> Option<String> {
    if provider_id == LOCAL_PROVIDER_ID {
        return None;
    }
    let env_name = if provider_id == "anthropic" {
        Some("ANTHROPIC_API_KEY")
    } else {
        crate::llm::remote_provider(provider_id).map(|r| r.env_key)
    };
    if let Some(k) = env_name.and_then(env_var_key) {
        return Some(k);
    }
    // Google publishes both spellings; accept the older one too.
    if provider_id == "google" {
        if let Some(k) = env_var_key("GOOGLE_API_KEY") {
            return Some(k);
        }
    }
    // The persisted home: the encrypted install-global secrets store.
    if let Some(k) = crate::secrets::get_provider_key(provider_id) {
        return Some(k);
    }
    // Transient safety net for a profile struct read before load()'s
    // migration stripped its plaintext fields (normally both are empty).
    if let Some(k) = p.api_keys.get(provider_id).filter(|k| !k.is_empty()) {
        return Some(k.clone());
    }
    if provider_id == "anthropic" {
        return p.api_key.clone().filter(|k| !k.is_empty());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §3 pinned fallback: desktop normalizes to the private local default;
    /// a mobile shell normalizes to NO provider (deterministic answers only,
    /// until the first saved key selects a cloud provider). KEEP IN SYNC with
    /// the defaultProviderFor pin in test/localModelPlatform.test.mjs.
    #[test]
    fn default_provider_is_platform_aware() {
        let local = (
            Some(LOCAL_PROVIDER_ID.to_string()),
            Some(LOCAL_MODEL_ID.to_string()),
        );
        // Desktop always defaults to the private model — the backend flag is moot.
        assert_eq!(default_provider_for("desktop", false), local);
        assert_eq!(default_provider_for("desktop", true), local);
        // add-mobile-local-inference: a mobile shell defaults to the private model
        // ONLY with a reported on-device backend; without one, NO provider (§3).
        assert_eq!(default_provider_for("ios", true), local);
        assert_eq!(default_provider_for("android", true), local);
        assert_eq!(default_provider_for("ios", false), (None, None));
        assert_eq!(default_provider_for("android", false), (None, None));
    }
}
