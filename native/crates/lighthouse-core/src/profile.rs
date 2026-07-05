//! Local profile + onboarding state, persisted to `.rag-vault/profile.json`
//! (port of `src/server/profile.ts`). Single-user standalone: "auth" is a
//! locally-stored profile plus the chosen model provider/key. The API key never
//! leaves the machine and is never returned to the client (only `hasApiKey`).

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
    /// Kept server-side only; surfaced to the client solely as `hasApiKey`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
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
            model_ever_selected: None,
            default_inclusion_choice: None,
        }
    }
}

/// Provider ids the app can actually answer with (mirrors the TS server's
/// KNOWN_PROVIDER_IDS). Earlier builds offered openai/google/mistral in the
/// picker but never wired them to a backend — a profile that still carries one
/// is normalized to the private local default, so the UI never claims excerpts
/// go to a provider that is never called. The stored key is left untouched.
const KNOWN_PROVIDER_IDS: [&str; 2] = [LOCAL_PROVIDER_ID, "anthropic"];

fn load() -> StoredProfile {
    let mut p: StoredProfile = read_json(&profile_path(), StoredProfile::default());
    if let Some(id) = p.provider_id.as_deref() {
        if !KNOWN_PROVIDER_IDS.contains(&id) {
            p.provider_id = Some(LOCAL_PROVIDER_ID.to_string());
            p.model_id = Some(LOCAL_MODEL_ID.to_string());
            save(&p);
        }
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
    OnboardingState {
        step: p.step,
        user: p.user,
        provider_id: p.provider_id,
        model_id: p.model_id,
        has_api_key: p.api_key.map(|k| !k.is_empty()).unwrap_or(false) || p.has_api_key,
        onboarding_variant: get_variant("onboarding"),
        default_inclusion_variant: get_variant("default_inclusion"),
        default_inclusion: effective_default_inclusion(),
    }
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
    let key = api_key.trim().to_string();
    let initial = !p.model_ever_selected.unwrap_or(false);
    let changed =
        p.provider_id.as_deref() != Some(provider_id) || p.model_id.as_deref() != Some(model_id);
    let next = StoredProfile {
        provider_id: Some(provider_id.to_string()),
        model_id: Some(model_id.to_string()),
        api_key: if key.is_empty() {
            p.api_key.clone()
        } else {
            Some(key.clone())
        },
        has_api_key: !key.is_empty() || p.has_api_key,
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
    save(&StoredProfile::default());
}

/// Resolved model config for the chat route (env key overrides stored key).
pub fn model_config() -> ModelCfg {
    let p = load();
    let env_key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    ModelCfg {
        provider_id: p.provider_id,
        model_id: p.model_id,
        api_key: env_key.or(p.api_key).filter(|k| !k.is_empty()),
    }
}
