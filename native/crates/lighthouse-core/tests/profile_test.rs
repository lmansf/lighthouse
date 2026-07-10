//! Per-provider API key storage: migration from the legacy single-key slot,
//! per-provider save/resolve, env-var override, and picker-id hygiene. The TS
//! twin (src/server/profile.ts) mirrors these semantics.

mod common;

use lighthouse_core::{llm, profile};

/// The resolver consults per-provider env vars — a key set in the developer's
/// shell must not leak into assertions.
fn clear_provider_env() {
    for var in ["ANTHROPIC_API_KEY", "GOOGLE_API_KEY"] {
        std::env::remove_var(var);
    }
    for p in llm::OPENAI_COMPAT_PROVIDERS {
        std::env::remove_var(p.env_key);
    }
}

#[test]
fn keys_are_stored_per_provider_and_never_cross_vendors() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    clear_provider_env();

    // Select Anthropic with a key, then switch to OpenAI with a different key.
    profile::select_model("anthropic", "claude-sonnet-5", "sk-ant-test");
    let cfg = profile::model_config();
    assert_eq!(cfg.provider_id.as_deref(), Some("anthropic"));
    assert_eq!(cfg.api_key.as_deref(), Some("sk-ant-test"));

    profile::select_model("openai", "gpt-5-mini", "sk-oa-test");
    let cfg = profile::model_config();
    assert_eq!(cfg.provider_id.as_deref(), Some("openai"));
    assert_eq!(
        cfg.api_key.as_deref(),
        Some("sk-oa-test"),
        "an OpenAI chat must never be handed the Anthropic key"
    );

    // Switching back WITHOUT re-pasting keeps the anthropic key.
    profile::select_model("anthropic", "claude-haiku-4-5", "");
    assert_eq!(profile::model_config().api_key.as_deref(), Some("sk-ant-test"));

    // Both providers report as keyed; the client-facing state never carries
    // the raw keys.
    let state = profile::get_state();
    assert!(state.has_api_key);
    assert!(state.keyed_providers.contains(&"anthropic".to_string()));
    assert!(state.keyed_providers.contains(&"openai".to_string()));
    let json = serde_json::to_string(&state).unwrap();
    assert!(
        !json.contains("sk-ant-test") && !json.contains("sk-oa-test"),
        "keys must never reach the client: {json}"
    );
}

#[test]
fn legacy_single_key_profiles_migrate_to_the_anthropic_slot() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    clear_provider_env();

    // A 0.6.x profile: single apiKey field, anthropic selected.
    let state_dir = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("profile.json"),
        r#"{"step":"done","user":null,"providerId":"anthropic","modelId":"claude-haiku-4-5","hasApiKey":true,"apiKey":"sk-legacy"}"#,
    )
    .unwrap();

    assert_eq!(profile::model_config().api_key.as_deref(), Some("sk-legacy"));
    let state = profile::get_state();
    assert!(state.has_api_key);
    assert!(state.keyed_providers.contains(&"anthropic".to_string()));

    // The migrated key belongs to Anthropic — a switch to xAI is keyless.
    profile::select_model("xai", "grok-4", "");
    let cfg = profile::model_config();
    assert_eq!(cfg.provider_id.as_deref(), Some("xai"));
    assert_eq!(cfg.api_key, None, "the anthropic key must not leak to xai");
    assert!(!profile::get_state().has_api_key, "xai has no key yet");
}

#[test]
fn unknown_providers_normalize_to_local_but_wired_ones_are_known() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    clear_provider_env();

    let state_dir = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("profile.json"),
        r#"{"step":"done","user":null,"providerId":"cohere","modelId":"command-r","hasApiKey":false}"#,
    )
    .unwrap();
    assert_eq!(
        profile::get_state().provider_id.as_deref(),
        Some("local"),
        "an unwired provider normalizes to the private local default"
    );

    // Every wired provider survives a round-trip un-normalized.
    for p in llm::OPENAI_COMPAT_PROVIDERS {
        profile::select_model(p.id, p.default_model, "k");
        assert_eq!(profile::get_state().provider_id.as_deref(), Some(p.id));
    }
}

#[test]
fn env_var_overrides_the_stored_key_per_provider() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    clear_provider_env();

    profile::select_model("mistral", "mistral-medium-latest", "stored-key");
    std::env::set_var("MISTRAL_API_KEY", "env-key");
    assert_eq!(profile::model_config().api_key.as_deref(), Some("env-key"));
    std::env::remove_var("MISTRAL_API_KEY");
    assert_eq!(profile::model_config().api_key.as_deref(), Some("stored-key"));
}
