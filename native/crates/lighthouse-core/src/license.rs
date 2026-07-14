//! Licensing, telemetry, and checkout plumbing — desktop side (port of
//! `src/server/license.ts`).
//!
//! The secrets live ONLY in the hosted Supabase Edge Function; the desktop
//! holds just the function's public URL and anon key. Nothing is ever DELETED:
//! when a license isn't valid the app locks, files stay on disk. Modes: Hosted
//! (LICENSE_API_URL), Local (LICENSE_ENFORCE=1, self-contained crypto),
//! Disabled. All telemetry is best-effort and swallows its own errors.

use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{app_state_dir, app_version, now_ms, parse_ms, read_json, utc_day, write_json};
use crate::experiment::{assign_balanced_variants, get_all_variants};
use crate::usage::{
    is_usage_opted_out, purge_usage_buffer, read_usage_buffer, reset_usage_consent,
};

const TRIAL_DAYS: i64 = 14;
const GRACE_DAYS: i64 = 14;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

// License state is install-global (app_state_dir), NOT per-vault: switching
// vaults must not sign the user out. See config::app_state_dir.
fn license_path() -> PathBuf {
    app_state_dir().join("license.json")
}
fn identity_path() -> PathBuf {
    app_state_dir().join("identity.json")
}
fn contact_id_path() -> PathBuf {
    app_state_dir().join("contact.json")
}
fn launch_path() -> PathBuf {
    app_state_dir().join("launch.json")
}

/// A stable per-user contact id, generated once and kept across trials, locks,
/// and purchases.
pub fn get_contact_id() -> String {
    #[derive(Serialize, Deserialize)]
    struct Contact {
        id: String,
    }
    if let Some(c) = read_json::<Option<Contact>>(&contact_id_path(), None) {
        if !c.id.is_empty() {
            return c.id;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    write_json(&contact_id_path(), &Contact { id: id.clone() });
    id
}

/// Welcome-registration contact shape (port of `registration.ts`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub last_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub do_not_contact: bool,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub state: String,
}

/// Whether trial registration is wired up (hosted license function present).
pub fn is_supabase_configured() -> bool {
    license_api().is_some()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLicense {
    #[serde(default)]
    guid: String,
    #[serde(default)]
    license_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    license_type: Option<String>, // absent ⇒ "trial" (back-compat)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trial_end: Option<String>, // paid: paid_through; trial: nominal (display only)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grace_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_days: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_active_day: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseResult {
    pub status: String, // valid | expired | grace | locked | none | disabled
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trial_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_days: Option<i64>,
}

impl LicenseResult {
    fn status(s: &str) -> Self {
        LicenseResult {
            status: s.to_string(),
            ..Default::default()
        }
    }
}

/// The hosted Edge Function URL, or None when not configured.
fn license_api() -> Option<String> {
    std::env::var("LICENSE_API_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Local-dev trial: enforced, self-contained, no hosted function.
fn local_mode() -> bool {
    license_api().is_none()
        && std::env::var("LICENSE_ENFORCE")
            .map(|v| v == "1")
            .unwrap_or(false)
}

pub fn licensing_enabled() -> bool {
    license_api().is_some() || local_mode()
}

/// Whether paid subscriptions are offered (PAID_ENABLED=1).
pub fn paid_enabled() -> bool {
    std::env::var("PAID_ENABLED")
        .map(|v| v == "1")
        .unwrap_or(false)
}

// --- hosted Edge Function -------------------------------------------------------

/// Call the license Edge Function. Errors on non-2xx / network failure.
pub async fn call_fn(op: &str, extra: Value) -> anyhow::Result<Value> {
    let Some(url) = license_api() else {
        anyhow::bail!("LICENSE_API_URL not configured");
    };
    let anon = std::env::var("SUPABASE_ANON_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let mut body = json!({ "op": op });
    if let (Some(obj), Some(extra_obj)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);
    if let Some(anon) = anon {
        req = req
            .header("apikey", &anon)
            .header("authorization", format!("Bearer {anon}"));
    }
    let res = req.send().await?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "license fn {status}: {}",
            text.chars().take(200).collect::<String>()
        );
    }
    Ok(res.json().await?)
}

// --- local-dev crypto (AES-256-GCM, scrypt-derived key) ---------------------------

fn secret_key() -> [u8; 32] {
    let secret = std::env::var("LICENSE_SECRET")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "lighthouse-insecure-default-secret".to_string());
    let mut key = [0u8; 32];
    // Node's scryptSync defaults: N=16384 (log2=14), r=8, p=1.
    let params = scrypt::Params::new(14, 8, 1, 32).expect("static scrypt params");
    scrypt::scrypt(
        secret.as_bytes(),
        b"lighthouse-license-v1",
        &params,
        &mut key,
    )
    .expect("scrypt derivation");
    key
}

fn encrypt(payload: &Value) -> String {
    let key = secret_key();
    let cipher = Aes256Gcm::new_from_slice(&key).expect("32-byte key");
    let mut iv = [0u8; 12];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut iv);
    let plaintext = serde_json::to_vec(payload).unwrap_or_default();
    let sealed = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_ref())
        .unwrap_or_default();
    // aes-gcm appends the 16-byte tag to the ciphertext; Node's layout is
    // iv | tag | ciphertext — reorder to stay token-compatible.
    let (ct, tag) = sealed.split_at(sealed.len().saturating_sub(16));
    let mut out = Vec::with_capacity(12 + 16 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(tag);
    out.extend_from_slice(ct);
    base64::engine::general_purpose::STANDARD.encode(out)
}

fn decrypt(token: &str) -> Option<Value> {
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
    let key = secret_key();
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let plain = cipher
        .decrypt(Nonce::from_slice(iv), sealed.as_ref())
        .ok()?;
    serde_json::from_slice(&plain).ok()
}

// --- contact identity persists across locks ---------------------------------------

fn load_identity() -> Option<Registration> {
    read_json(&identity_path(), None)
}

fn contact_row(c: &Registration) -> Value {
    json!({
        "contactId": get_contact_id(),
        "firstName": c.first_name,
        "lastName": c.last_name,
        "email": c.email,
        "doNotContact": c.do_not_contact,
        "city": c.city,
        "state": c.state,
    })
}

/// Email to stamp on logs/bug reports: the signed-in account first, then the
/// license identity.
pub fn account_email() -> Option<String> {
    let from_profile = crate::profile::get_state()
        .user
        .map(|u| u.email.trim().to_string())
        .filter(|e| !e.is_empty());
    if from_profile.is_some() {
        return from_profile;
    }
    load_identity().map(|i| i.email).filter(|e| !e.is_empty())
}

/// Mint a fresh trial: new GUID + encrypted key + a 14 sign-in-day allowance.
pub async fn start_trial(contact: Option<Registration>) -> anyhow::Result<String> {
    let use_contact = contact.or_else(load_identity);
    if let Some(c) = &use_contact {
        write_json(&identity_path(), c);
    }

    // A fresh trial resets usage-logging consent to its default (opted OUT).
    reset_usage_consent();

    // Balance this install into the under-represented variant server-side.
    // Best-effort and idempotent.
    let _ = assign_balanced_variants().await;

    if license_api().is_some() {
        let extra = match &use_contact {
            Some(c) => json!({ "contact": contact_row(c) }),
            None => json!({}),
        };
        let r = call_fn("start", extra).await?;
        if r["ok"] == false {
            anyhow::bail!(r["detail"]
                .as_str()
                .unwrap_or("trial start rejected")
                .to_string());
        }
        let guid = r["guid"].as_str().unwrap_or_default().to_string();
        write_json(
            &license_path(),
            &LocalLicense {
                guid: guid.clone(),
                license_key: r["licenseKey"].as_str().unwrap_or_default().to_string(),
                license_type: Some("trial".to_string()),
                trial_end: r["trialEnd"].as_str().map(String::from),
                ..Default::default()
            },
        );
        return Ok(guid);
    }

    // local-dev (or disabled) — self-contained trial, no Supabase
    let guid = uuid::Uuid::new_v4().to_string();
    let license_key =
        encrypt(&json!({ "guid": guid, "iat": crate::config::iso_now(), "type": "trial" }));
    write_json(
        &license_path(),
        &LocalLicense {
            guid: guid.clone(),
            license_key,
            license_type: Some("trial".to_string()),
            active_days: Some(0),
            ..Default::default()
        },
    );
    Ok(guid)
}

/// Activate a pasted license key. Validated hosted-side or by decoding locally;
/// stored only on a usable (valid/grace) status. Never destructive.
pub async fn activate_license(license_key: &str) -> LicenseResult {
    let key = license_key.trim();
    if key.is_empty() {
        return LicenseResult::status("none");
    }

    if license_api().is_some() {
        let Ok(r) = call_fn("check", json!({ "licenseKey": key })).await else {
            return LicenseResult::status("none"); // unreachable — can't validate
        };
        let status = r["status"].as_str().unwrap_or("none").to_string();
        if status == "valid" || status == "grace" {
            let lic = LocalLicense {
                guid: r["guid"]
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                license_key: key.to_string(),
                license_type: Some(r["licenseType"].as_str().unwrap_or("paid").to_string()),
                trial_end: r["paidThrough"]
                    .as_str()
                    .or(r["trialEnd"].as_str())
                    .map(String::from)
                    .filter(|s| !s.is_empty()),
                grace_until: r["graceUntil"].as_str().map(String::from),
                ..Default::default()
            };
            write_json(&license_path(), &lic);
            return LicenseResult {
                status,
                license_type: lic.license_type,
                trial_end: lic.trial_end,
                grace_until: lic.grace_until,
                remaining_days: None,
            };
        }
        return LicenseResult::status(&status);
    }

    // local-dev: decode and validate BEFORE persisting, so pasting an expired
    // key never clobbers a currently-valid license.
    let Some(decoded) = decrypt(key) else {
        return LicenseResult::status("none");
    };
    let guid = decoded["guid"].as_str().unwrap_or_default().to_string();
    if guid.is_empty() {
        return LicenseResult::status("none");
    }
    let license_type = decoded["type"].as_str().unwrap_or("trial").to_string();
    let paid_through = decoded["paidThrough"].as_str().map(String::from);
    let result = if license_type == "paid" {
        paid_status_from(paid_through.as_deref(), None)
    } else {
        LicenseResult {
            status: "valid".to_string(),
            license_type: Some("trial".to_string()),
            remaining_days: Some(TRIAL_DAYS),
            ..Default::default()
        }
    };
    if result.status == "valid" || result.status == "grace" {
        write_json(
            &license_path(),
            &LocalLicense {
                guid,
                license_key: key.to_string(),
                license_type: Some(license_type.clone()),
                trial_end: paid_through,
                active_days: if license_type == "trial" {
                    Some(0)
                } else {
                    None
                },
                ..Default::default()
            },
        );
    }
    result
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub last_name: String,
    #[serde(default)]
    pub ease_of_use: f64,
    #[serde(default)]
    pub overall_value: f64,
    #[serde(default)]
    pub liked: String,
    #[serde(default)]
    pub change_or_add: String,
    #[serde(default)]
    pub notify_when_available: bool,
}

/// Record a feedback-form submission, stamped with the stable contact id. In
/// local-dev (no hosted function) feedback is accepted but not stored.
pub async fn submit_feedback(f: &FeedbackInput) -> bool {
    let existing = load_identity();
    let email = account_email()
        .or_else(|| existing.as_ref().map(|i| i.email.clone()))
        .unwrap_or_default();
    let do_not_contact = existing.as_ref().map(|i| i.do_not_contact).unwrap_or(false);
    write_json(
        &identity_path(),
        &Registration {
            first_name: f.first_name.clone(),
            last_name: f.last_name.clone(),
            email: email.clone(),
            do_not_contact,
            city: existing
                .as_ref()
                .map(|i| i.city.clone())
                .unwrap_or_default(),
            state: existing
                .as_ref()
                .map(|i| i.state.clone())
                .unwrap_or_default(),
        },
    );
    if license_api().is_none() {
        return true;
    }
    let feedback = json!({
        "firstName": f.first_name,
        "lastName": f.last_name,
        "easeOfUse": f.ease_of_use,
        "overallValue": f.overall_value,
        "liked": f.liked,
        "changeOrAdd": f.change_or_add,
        "notifyWhenAvailable": f.notify_when_available,
        "email": email,
        "doNotContact": do_not_contact,
        "contactId": get_contact_id(),
        "experiments": get_all_variants(),
    });
    match call_fn("feedback", json!({ "feedback": feedback })).await {
        Ok(r) => r["ok"] != false,
        Err(_) => false,
    }
}

/// Record a feature-interest vote — which shelved features the user would use.
/// Linked by the stable contact id; stored in its own `feature_interest` table.
pub async fn submit_feature_interest(shown: &[String], wanted: &[String]) -> bool {
    if license_api().is_none() {
        return true;
    }
    let vote = json!({
        "shown": shown,
        "wanted": wanted,
        "contactId": get_contact_id(),
    });
    match call_fn("featureInterest", json!({ "vote": vote })).await {
        Ok(r) => r["ok"] != false,
        Err(_) => false,
    }
}

/// Register interest in purchasing while paid mode is off.
pub async fn submit_notify(email: &str) -> bool {
    let trimmed = email.trim();
    if trimmed.is_empty() {
        return false;
    }
    let id = load_identity();
    write_json(
        &identity_path(),
        &Registration {
            first_name: id
                .as_ref()
                .map(|i| i.first_name.clone())
                .unwrap_or_default(),
            last_name: id.as_ref().map(|i| i.last_name.clone()).unwrap_or_default(),
            email: trimmed.to_string(),
            do_not_contact: id.as_ref().map(|i| i.do_not_contact).unwrap_or(false),
            city: id.as_ref().map(|i| i.city.clone()).unwrap_or_default(),
            state: id.as_ref().map(|i| i.state.clone()).unwrap_or_default(),
        },
    );
    if license_api().is_none() {
        return true;
    }
    match call_fn(
        "notify",
        json!({ "email": trimmed, "contactId": get_contact_id() }),
    )
    .await
    {
        Ok(r) => r["ok"] != false,
        Err(_) => false,
    }
}

/// Get a Stripe Checkout URL for this install (None when not configured).
pub async fn checkout_url(email: Option<&str>) -> Option<String> {
    let api = std::env::var("CHECKOUT_API_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let mut lic: Option<LocalLicense> = read_json(&license_path(), None);
    if lic.as_ref().map(|l| l.guid.is_empty()).unwrap_or(true) {
        let _ = start_trial(None).await;
        lic = read_json(&license_path(), None);
    }
    let id = load_identity();
    let buyer_email = email
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .or_else(|| {
            id.as_ref()
                .map(|i| i.email.clone())
                .filter(|e| !e.is_empty())
        })
        .unwrap_or_default();
    if !buyer_email.is_empty() {
        write_json(
            &identity_path(),
            &Registration {
                first_name: id
                    .as_ref()
                    .map(|i| i.first_name.clone())
                    .unwrap_or_default(),
                last_name: id.as_ref().map(|i| i.last_name.clone()).unwrap_or_default(),
                email: buyer_email.clone(),
                do_not_contact: id.as_ref().map(|i| i.do_not_contact).unwrap_or(false),
                city: id.as_ref().map(|i| i.city.clone()).unwrap_or_default(),
                state: id.as_ref().map(|i| i.state.clone()).unwrap_or_default(),
            },
        );
    }
    let anon = std::env::var("SUPABASE_ANON_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let mut body = json!({ "guid": lic.map(|l| l.guid) });
    if !buyer_email.is_empty() {
        body["email"] = json!(buyer_email);
    }
    let client = reqwest::Client::new();
    let mut req = client
        .post(&api)
        .header("content-type", "application/json")
        .json(&body);
    if let Some(anon) = anon {
        req = req
            .header("apikey", &anon)
            .header("authorization", format!("Bearer {anon}"));
    }
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let data: Value = res.json().await.ok()?;
    data["url"].as_str().map(String::from)
}

/// Send an in-app bug report (with the install's guid/email) to Supabase.
pub async fn submit_bug(where_: &str, what: &str) -> bool {
    if license_api().is_none() {
        return true;
    }
    let lic: Option<LocalLicense> = read_json(&license_path(), None);
    let r = call_fn(
        "bug",
        json!({
            "where": where_,
            "what": what,
            "contactId": get_contact_id(),
            "guid": lic.map(|l| l.guid),
            "email": account_email(),
            "version": app_version(),
        }),
    )
    .await;
    match r {
        Ok(r) => r["ok"] != false,
        Err(_) => false,
    }
}

/// Log an app launch to the userlogs table (best-effort; hosted mode only) and
/// derive a `returned` event (any launch on a later calendar day, once per day).
pub async fn ping_launch() {
    // Managed policy: telemetry "off" silences the launch ping (the license
    // `check` is separate and remains — documented in data-flows.md).
    if !crate::policy::telemetry_allowed() {
        return;
    }
    if license_api().is_some() {
        let lic: Option<LocalLicense> = read_json(&license_path(), None);
        let _ = call_fn(
            "ping",
            json!({
                "contactId": get_contact_id(),
                "guid": lic.map(|l| l.guid),
                "email": account_email(),
                "version": app_version(),
                "experiments": get_all_variants(),
            }),
        )
        .await;
    } else {
        return;
    }

    #[derive(Default, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Launch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        first_day: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_returned_day: Option<String>,
    }
    let launch: Launch = read_json(&launch_path(), Launch::default());
    let today = utc_day();
    if launch.first_day.is_none() {
        write_json(
            &launch_path(),
            &Launch {
                first_day: Some(today),
                ..launch
            },
        );
    } else if launch.first_day.as_deref() != Some(&today)
        && launch.last_returned_day.as_deref() != Some(&today)
    {
        let first = launch.first_day.clone();
        write_json(
            &launch_path(),
            &Launch {
                first_day: first.clone(),
                last_returned_day: Some(today.clone()),
            },
        );
        let day = match (parse_ms(&today), first.as_deref().and_then(parse_ms)) {
            (Some(t), Some(f)) => ((t - f) as f64 / DAY_MS as f64).round() as i64,
            _ => 0,
        };
        record_event("returned", json!({ "day": day })).await;
    }
}

/// Record a funnel/telemetry event (best-effort; hosted mode only). Must never
/// throw into a launch, a query, or onboarding — all errors are swallowed.
pub async fn record_event(name: &str, props: Value) {
    if license_api().is_none() || !crate::policy::telemetry_allowed() {
        return;
    }
    let _ = call_fn(
        "event",
        json!({
            "contactId": get_contact_id(),
            "name": name,
            "experiments": get_all_variants(),
            "props": props,
        }),
    )
    .await;
}

/// Publish buffered UI click events, then purge exactly what was sent.
/// Best-effort: opted out, offline, or not hosted ⇒ buffer kept for next launch.
pub async fn publish_usage_events() {
    if license_api().is_none() || is_usage_opted_out() {
        return;
    }
    let (events, line_count) = read_usage_buffer();
    if events.is_empty() {
        return;
    }
    let lic: Option<LocalLicense> = read_json(&license_path(), None);
    let r = call_fn(
        "events",
        json!({
            "contactId": get_contact_id(),
            "guid": lic.map(|l| l.guid),
            "email": account_email(),
            "version": app_version(),
            "events": events,
        }),
    )
    .await;
    match r {
        Ok(r) if r["ok"] == false => {} // keep the buffer; retry next launch
        Ok(_) => purge_usage_buffer(line_count),
        Err(_) => {} // offline — keep the buffer
    }
}

// --- paid status from an end date (shared by offline + local-dev paths) -----------

fn paid_status_from(end: Option<&str>, grace_until: Option<&str>) -> LicenseResult {
    let Some(end_ms) = end.and_then(parse_ms) else {
        return LicenseResult {
            status: "valid".to_string(),
            license_type: Some("paid".to_string()),
            ..Default::default()
        }; // open-ended
    };
    let grace_ms = grace_until
        .and_then(parse_ms)
        .unwrap_or(end_ms + GRACE_DAYS * DAY_MS);
    let now = now_ms();
    let gu = chrono::DateTime::from_timestamp_millis(grace_ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
    let end_s = end.map(String::from);
    if now <= end_ms {
        return LicenseResult {
            status: "valid".to_string(),
            license_type: Some("paid".to_string()),
            trial_end: end_s,
            ..Default::default()
        };
    }
    if now <= grace_ms {
        return LicenseResult {
            status: "grace".to_string(),
            license_type: Some("paid".to_string()),
            trial_end: end_s,
            grace_until: gu,
            ..Default::default()
        };
    }
    LicenseResult {
        status: "locked".to_string(),
        license_type: Some("paid".to_string()),
        trial_end: end_s,
        grace_until: gu,
        ..Default::default()
    }
}

/// Check the stored license once per launch. Authoritative in hosted mode; an
/// unreachable function is treated leniently (never locks a trial offline).
pub async fn check_license() -> LicenseResult {
    if !licensing_enabled() {
        return LicenseResult::status("disabled");
    }

    let lic: Option<LocalLicense> = read_json(&license_path(), None);
    let Some(lic) = lic.filter(|l| !l.guid.is_empty() && !l.license_key.is_empty()) else {
        return LicenseResult::status("none");
    };

    if license_api().is_some() {
        match call_fn("check", json!({ "licenseKey": lic.license_key })).await {
            Ok(r) => {
                let status = r["status"].as_str().unwrap_or("none").to_string();
                let license_type = r["licenseType"]
                    .as_str()
                    .map(String::from)
                    .or(lic.license_type.clone())
                    .or(Some("trial".to_string()));
                let trial_end = r["paidThrough"]
                    .as_str()
                    .or(r["trialEnd"].as_str())
                    .map(String::from)
                    .or(lic.trial_end.clone());
                let grace_until = r["graceUntil"].as_str().map(String::from);
                let remaining_days = r["remainingDays"].as_i64();

                // Cache the latest authoritative values for offline fallback.
                if status == "valid" || status == "grace" || status == "locked" {
                    write_json(
                        &license_path(),
                        &LocalLicense {
                            license_type: license_type.clone(),
                            trial_end: trial_end.clone(),
                            grace_until: grace_until.clone(),
                            ..lic
                        },
                    );
                }
                LicenseResult {
                    status,
                    license_type,
                    trial_end,
                    grace_until,
                    remaining_days,
                }
            }
            Err(_) => {
                // Offline: never lock a trial; paid falls back to cached dates.
                if lic.license_type.as_deref() == Some("paid") {
                    paid_status_from(lic.trial_end.as_deref(), lic.grace_until.as_deref())
                } else {
                    LicenseResult {
                        status: "valid".to_string(),
                        license_type: Some("trial".to_string()),
                        ..Default::default()
                    }
                }
            }
        }
    } else {
        // --- local-dev verification ---
        let Some(decoded) = decrypt(&lic.license_key) else {
            return LicenseResult::status("none");
        };
        if decoded["guid"].as_str() != Some(lic.guid.as_str()) {
            return LicenseResult::status("none");
        }
        let license_type = lic
            .license_type
            .clone()
            .or_else(|| decoded["type"].as_str().map(String::from))
            .unwrap_or_else(|| "trial".to_string());

        if license_type == "paid" {
            let end = lic
                .trial_end
                .clone()
                .or_else(|| decoded["paidThrough"].as_str().map(String::from));
            return paid_status_from(end.as_deref(), lic.grace_until.as_deref());
        }

        // trial: count one sign-in day per new UTC day, lock past the allowance
        let today = utc_day();
        let mut active_days = lic.active_days.unwrap_or(0);
        if lic.last_active_day.as_deref() != Some(&today) {
            active_days += 1;
            write_json(
                &license_path(),
                &LocalLicense {
                    active_days: Some(active_days),
                    last_active_day: Some(today),
                    ..lic
                },
            );
        }
        let remaining_days = (TRIAL_DAYS - active_days).max(0);
        if active_days > TRIAL_DAYS {
            return LicenseResult {
                status: "expired".to_string(),
                license_type: Some("trial".to_string()),
                remaining_days: Some(0),
                ..Default::default()
            };
        }
        LicenseResult {
            status: "valid".to_string(),
            license_type: Some("trial".to_string()),
            remaining_days: Some(remaining_days),
            ..Default::default()
        }
    }
}
