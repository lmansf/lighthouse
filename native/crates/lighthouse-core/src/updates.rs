//! Update-artifact signature verification (updater "Phase B", signing pass).
//!
//! The desktop shell's click-to-update downloads an installer from the GitHub
//! release; before executing anything it verifies the artifact against the
//! release's `<asset>.sig` using the minisign public key baked into the build
//! (`LIGHTHOUSE_UPDATER_PUBKEY` at compile time — the key `tauri signer
//! generate` produces, whose private half signs artifacts in CI). No key baked
//! ⇒ the shell never downloads at all (notify-only). This module is the pure,
//! engine-side half so it stays unit-testable without a webview.
//!
//! Format notes (Tauri v2 conventions):
//! - the `.sig` release asset contains BASE64 of a full minisign signature
//!   file (untrusted comment / sig / trusted comment / global sig);
//! - the public key is BASE64 of a full minisign public-key file.
//! Raw (un-base64'd) minisign content is accepted too, so hand-generated
//! keys/signatures verify the same way.

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};

/// Decode `input` as base64-of-minisign-file if possible, else return it
/// verbatim (already the raw minisign text).
fn unwrap_b64(input: &str) -> String {
    let trimmed = input.trim();
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(trimmed) {
        if let Ok(text) = String::from_utf8(decoded) {
            return text;
        }
    }
    trimmed.to_string()
}

fn parse_pubkey(pubkey: &str) -> Result<PublicKey> {
    let text = unwrap_b64(pubkey);
    let text = text.trim();
    // Full .pub file (with comment line) or the bare key line.
    if text.contains('\n') || text.starts_with("untrusted comment:") {
        PublicKey::decode(text).map_err(|e| anyhow!("bad updater public key: {e}"))
    } else {
        PublicKey::from_base64(text).map_err(|e| anyhow!("bad updater public key: {e}"))
    }
}

/// Verify `data` (the downloaded installer bytes) against a minisign
/// signature (`sig` — the `.sig` asset's content) and the baked-in public key.
/// Errors on ANY mismatch: tampered artifact, wrong key, malformed inputs.
pub fn verify_update_signature(data: &[u8], sig: &str, pubkey: &str) -> Result<()> {
    let pk = parse_pubkey(pubkey)?;
    let sig_text = unwrap_b64(sig);
    let signature =
        Signature::decode(sig_text.trim()).map_err(|e| anyhow!("bad signature format: {e}"))?;
    pk.verify(data, &signature, false)
        .context("update artifact failed signature verification")
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    /// Generate a keypair + signature the way `tauri signer sign` lays them
    /// out: base64 of the full minisign key/signature files.
    fn tauri_style_fixture(data: &[u8]) -> (String, String, String) {
        let kp = minisign::KeyPair::generate_unencrypted_keypair().expect("keypair");
        let pk_box = kp.pk.to_box().expect("pk box").into_string();
        let sk = kp.sk;
        let sig_box = minisign::sign(
            None,
            &sk,
            std::io::Cursor::new(data),
            Some("lighthouse test sig"),
            None,
        )
        .expect("sign")
        .into_string();
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
        // (tauri-style pubkey, tauri-style sig, raw pubkey file) — the raw
        // variant exercises the unwrapped-input acceptance path.
        (b64(&pk_box), b64(&sig_box), pk_box)
    }

    #[test]
    fn a_valid_signature_verifies_and_any_tampering_fails() {
        let data = b"installer bytes: definitely a real NSIS artifact";
        let (pubkey_b64, sig_b64, pubkey_raw) = tauri_style_fixture(data);

        // Happy path — tauri-style base64-wrapped inputs.
        verify_update_signature(data, &sig_b64, &pubkey_b64).expect("valid sig verifies");
        // Raw minisign pubkey accepted too.
        verify_update_signature(data, &sig_b64, &pubkey_raw)
            .expect("raw-format pubkey verifies");

        // Tampered artifact → refused.
        let mut evil = data.to_vec();
        evil[0] ^= 0xFF;
        assert!(
            verify_update_signature(&evil, &sig_b64, &pubkey_b64).is_err(),
            "tampered data must fail verification"
        );

        // Signature from a DIFFERENT key → refused.
        let (other_pubkey, _, _) = tauri_style_fixture(data);
        assert!(
            verify_update_signature(data, &sig_b64, &other_pubkey).is_err(),
            "wrong key must fail verification"
        );

        // Garbage inputs → clean errors, no panic.
        assert!(verify_update_signature(data, "not a signature", &pubkey_b64).is_err());
        assert!(verify_update_signature(data, &sig_b64, "not a key").is_err());
    }
}
