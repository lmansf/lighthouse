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
use crate::experiment::get_variant;
use crate::llm::ModelCfg;

const LOCAL_PROVIDER_ID: &str = "local";
const LOCAL_MODEL_ID: &str = "lighthouse-local";

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
    /// made during onboarding. Absent ⇒ fall back to the experiment variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_inclusion_choice: Option<String>,
}

fn default_step() -> String {
    "sign-in".to_string()
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
    if let Some(id) = p.provider_id.as_deref() {
        if !is_known_provider(id) {
            p.provider_id = Some(LOCAL_PROVIDER_ID.to_string());
            p.model_id = Some(LOCAL_MODEL_ID.to_string());
            dirty = true;
        }
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
    pub onboarding_variant: String,
    pub default_inclusion_variant: String,
    /// The effective default-inclusion behavior ("include"/"exclude").
    pub default_inclusion: String,
}

/// The user's *effective* default-inclusion behavior: their explicit onboarding
/// choice if made, else derived from the assigned experiment variant
/// (opt_out → include, opt_in → exclude). Single source of truth for the vault
/// engine and the UI.
pub fn effective_default_inclusion() -> String {
    match load().default_inclusion_choice.as_deref() {
        Some("include") => "include".to_string(),
        Some("exclude") => "exclude".to_string(),
        _ => {
            if get_variant("default_inclusion") == "opt_out" {
                "include".to_string()
            } else {
                "exclude".to_string()
            }
        }
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
        onboarding_variant: get_variant("onboarding"),
        default_inclusion_variant: get_variant("default_inclusion"),
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

pub fn sign_in(email: &str) -> User {
    let mut p = load();
    let name = email.split('@').next().unwrap_or("").to_string();
    let user = User {
        id: "local".to_string(),
        name: if name.is_empty() {
            "User".to_string()
        } else {
            name
        },
        email: email.to_string(),
    };
    p.user = Some(user.clone());
    p.step = "register".to_string();
    save(&p);
    user
}

pub fn register(name: &str, email: &str) -> User {
    let mut p = load();
    let user = User {
        id: "local".to_string(),
        name: name.to_string(),
        email: email.to_string(),
    };
    p.user = Some(user.clone());
    p.step = "register".to_string();
    save(&p);
    user
}

/// Result of a model selection so the API layer can emit a `model_selected`
/// analytics event without this module importing telemetry (avoids a cycle).
#[derive(Debug, Clone)]
pub struct ModelSelectionResult {
    pub initial: bool,
    pub changed: bool,
    pub provider: String,
    pub model: String,
    pub previous_provider: Option<String>,
    pub previous_model: Option<String>,
}

pub fn finish_registration() -> Option<ModelSelectionResult> {
    let p = load();
    // Onboarding A/B: play_first drops straight into the workspace on the
    // key-less local model; key_first keeps the classic select-model flow.
    if get_variant("onboarding") == "play_first" {
        let provider_id = p
            .provider_id
            .clone()
            .unwrap_or_else(|| LOCAL_PROVIDER_ID.to_string());
        let model_id = p
            .model_id
            .clone()
            .unwrap_or_else(|| LOCAL_MODEL_ID.to_string());
        let initial = !p.model_ever_selected.unwrap_or(false);
        let next = StoredProfile {
            provider_id: Some(provider_id.clone()),
            model_id: Some(model_id.clone()),
            step: "done".to_string(),
            model_ever_selected: Some(true),
            ..p.clone()
        };
        save(&next);
        return if initial {
            Some(ModelSelectionResult {
                initial: true,
                changed: false,
                provider: provider_id,
                model: model_id,
                previous_provider: p.provider_id,
                previous_model: p.model_id,
            })
        } else {
            None
        };
    }
    let mut next = p;
    next.step = "select-model".to_string();
    save(&next);
    None
}

pub fn select_model(provider_id: &str, model_id: &str, api_key: &str) -> ModelSelectionResult {
    let p = load();
    // Managed policy: never persist (or seal a key for) a disallowed
    // provider. The op layers reject with a proper error before calling
    // here; this belt-and-braces returns the profile unchanged for any
    // other caller. llm.rs additionally refuses at call time.
    if !crate::policy::provider_allowed(provider_id) {
        return ModelSelectionResult {
            initial: false,
            changed: false,
            provider: p.provider_id.clone().unwrap_or_default(),
            model: p.model_id.clone().unwrap_or_default(),
            previous_provider: p.provider_id,
            previous_model: p.model_id,
        };
    }
    let key = api_key.trim().to_string();
    let initial = !p.model_ever_selected.unwrap_or(false);
    let changed =
        p.provider_id.as_deref() != Some(provider_id) || p.model_id.as_deref() != Some(model_id);
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
        step: "done".to_string(),
        model_ever_selected: Some(true),
        ..p.clone()
    };
    save(&next);
    ModelSelectionResult {
        initial,
        changed,
        provider: provider_id.to_string(),
        model: model_id.to_string(),
        previous_provider: p.provider_id,
        previous_model: p.model_id,
    }
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
