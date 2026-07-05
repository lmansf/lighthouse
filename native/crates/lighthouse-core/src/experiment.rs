//! A/B experiment variant assignment (port of `src/server/experiment.ts`).
//!
//! Two independent experiments, each resolved ONCE per install and persisted to
//! `.rag-vault/experiments.json`. Assignment: pilot-email override → server-
//! balanced (license fn `assign`) → deterministic SHA-256 hash of the stable
//! contact id. Best-effort; must never throw into a launch or a query.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::{profile_path, read_json, state_dir, write_json};
use crate::license::{call_fn, get_contact_id};

fn identity_path() -> PathBuf {
    state_dir().join("identity.json")
}

/// The user's email, read straight from the stored profile / identity files.
/// Deliberately does NOT go through profile::get_state() (which resolves the
/// experiment variants) — reading the files directly breaks that recursion.
fn current_email() -> Option<String> {
    #[derive(Deserialize)]
    struct P {
        user: Option<UserEmail>,
    }
    #[derive(Deserialize)]
    struct UserEmail {
        email: Option<String>,
    }
    let profile: Option<P> = read_json(&profile_path(), None);
    if let Some(email) = profile
        .and_then(|p| p.user)
        .and_then(|u| u.email)
        .map(|e| e.trim().to_string())
    {
        if !email.is_empty() {
            return Some(email);
        }
    }
    #[derive(Deserialize)]
    struct I {
        email: Option<String>,
    }
    let identity: Option<I> = read_json(&identity_path(), None);
    identity
        .and_then(|i| i.email)
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Variants {
    pub onboarding: String,        // "play_first" | "key_first"
    pub default_inclusion: String, // "opt_in" | "opt_out"
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredVariants {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    onboarding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_inclusion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>, // "hash" | "override" | "server"
}

fn is_onboarding(v: &str) -> bool {
    v == "play_first" || v == "key_first"
}
fn is_default_inclusion(v: &str) -> bool {
    v == "opt_in" || v == "opt_out"
}

/// Per-experiment salt so a user's two buckets don't correlate.
fn salt(experiment: &str) -> &'static str {
    match experiment {
        "onboarding" => "onboarding:v1",
        _ => "default_inclusion:v1",
    }
}

/// The two variants of each experiment: [hash < 0.5, hash >= 0.5].
fn variant_pair(experiment: &str) -> (&'static str, &'static str) {
    match experiment {
        "onboarding" => ("play_first", "key_first"),
        _ => ("opt_in", "opt_out"),
    }
}

/// Hard-coded assignment for the first pilot users, keyed by lower-cased email —
/// a 2x2 factorial. (Placeholder addresses, mirrored from the TS side.)
fn first_user_override(email: &str) -> Option<Variants> {
    let v = match email {
        "user1@example.com" => ("play_first", "opt_in"),
        "user2@example.com" => ("key_first", "opt_out"),
        "user3@example.com" => ("play_first", "opt_out"),
        "user4@example.com" => ("key_first", "opt_in"),
        _ => return None,
    };
    Some(Variants {
        onboarding: v.0.to_string(),
        default_inclusion: v.1.to_string(),
    })
}

fn experiments_path() -> PathBuf {
    state_dir().join("experiments.json")
}

/// Deterministic hash of a string to the unit interval [0, 1) — the top 48 bits
/// of a SHA-256 digest divided by 2^48 (matches the TS implementation exactly).
pub fn hash_to_unit(s: &str) -> f64 {
    let digest = Sha256::digest(s.as_bytes());
    let mut n: u64 = 0;
    for b in &digest[..6] {
        n = (n << 8) | (*b as u64);
    }
    n as f64 / 2f64.powi(48)
}

fn assign(experiment: &str) -> String {
    let (a, b) = variant_pair(experiment);
    let contact = get_contact_id();
    if hash_to_unit(&format!("{contact}:{}", salt(experiment))) < 0.5 {
        a.to_string()
    } else {
        b.to_string()
    }
}

/// Resolve both variants once and persist; subsequent calls read the file.
fn resolve() -> Variants {
    let email = current_email().map(|e| e.to_lowercase());
    let override_v = email.as_deref().and_then(first_user_override);
    let stored: StoredVariants = read_json(&experiments_path(), StoredVariants::default());

    if let Some(ov) = override_v {
        let matches = stored.onboarding.as_deref() == Some(&ov.onboarding)
            && stored.default_inclusion.as_deref() == Some(&ov.default_inclusion)
            && stored.source.as_deref() == Some("override");
        if !matches {
            write_json(
                &experiments_path(),
                &StoredVariants {
                    onboarding: Some(ov.onboarding.clone()),
                    default_inclusion: Some(ov.default_inclusion.clone()),
                    source: Some("override".to_string()),
                },
            );
        }
        return ov;
    }

    if let (Some(o), Some(d)) = (&stored.onboarding, &stored.default_inclusion) {
        return Variants {
            onboarding: o.clone(),
            default_inclusion: d.clone(),
        };
    }

    // First resolve for a non-pilot user: deterministic hash, then persist.
    let resolved = Variants {
        onboarding: stored
            .onboarding
            .clone()
            .unwrap_or_else(|| assign("onboarding")),
        default_inclusion: stored
            .default_inclusion
            .clone()
            .unwrap_or_else(|| assign("default_inclusion")),
    };
    write_json(
        &experiments_path(),
        &StoredVariants {
            onboarding: Some(resolved.onboarding.clone()),
            default_inclusion: Some(resolved.default_inclusion.clone()),
            source: Some(stored.source.unwrap_or_else(|| "hash".to_string())),
        },
    );
    resolved
}

/// Balanced assignment, run once at registration. Asks the license function to
/// bucket this install into the under-represented variant. Stable + idempotent;
/// best-effort — any failure leaves the hash assignment in place.
pub async fn assign_balanced_variants() -> Variants {
    let email = current_email().map(|e| e.to_lowercase());
    if let Some(ov) = email.as_deref().and_then(first_user_override) {
        write_json(
            &experiments_path(),
            &StoredVariants {
                onboarding: Some(ov.onboarding.clone()),
                default_inclusion: Some(ov.default_inclusion.clone()),
                source: Some("override".to_string()),
            },
        );
        return ov;
    }

    let stored: StoredVariants = read_json(&experiments_path(), StoredVariants::default());
    if stored.source.as_deref() == Some("server") {
        if let (Some(o), Some(d)) = (&stored.onboarding, &stored.default_inclusion) {
            return Variants {
                onboarding: o.clone(),
                default_inclusion: d.clone(),
            };
        }
    }

    if let Ok(r) = call_fn(
        "assign",
        serde_json::json!({ "contactId": get_contact_id() }),
    )
    .await
    {
        let v = &r["variants"];
        let (o, d) = (
            v["onboarding"].as_str().unwrap_or(""),
            v["default_inclusion"].as_str().unwrap_or(""),
        );
        if is_onboarding(o) && is_default_inclusion(d) {
            let variants = Variants {
                onboarding: o.to_string(),
                default_inclusion: d.to_string(),
            };
            write_json(
                &experiments_path(),
                &StoredVariants {
                    onboarding: Some(variants.onboarding.clone()),
                    default_inclusion: Some(variants.default_inclusion.clone()),
                    source: Some("server".to_string()),
                },
            );
            return variants;
        }
    }
    resolve()
}

/// The user's variant for one experiment (resolved + persisted on first call).
pub fn get_variant(experiment: &str) -> String {
    let v = resolve();
    match experiment {
        "onboarding" => v.onboarding,
        _ => v.default_inclusion,
    }
}

/// All of the user's variants, for stamping onto telemetry rows.
pub fn get_all_variants() -> Variants {
    resolve()
}
