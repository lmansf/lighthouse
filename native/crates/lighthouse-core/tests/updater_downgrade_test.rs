//! Red-team 2026-08 — "forced downgrade": an update signature binds BYTES to
//! the key, NOT bytes to a version.
//!
//! Whoever can write the release channel (CI `GITHUB_TOKEN`, a maintainer
//! PAT/account, compromised CI — the adversary docs/auto-updater-design.md §2
//! already names, no key compromise needed) could re-upload an OLD release's
//! installer together with its own still-valid `.sig` under a NEW tag:
//! `check_for_updates` compares against the attacker-chosen TAG,
//! `pick_update_asset` matches by filename SUFFIX (never the version), and the
//! artifact's signature verifies because it is genuine. The app installed a
//! superseded build — re-arming every fix since — while the banner read the
//! higher version.
//!
//! The authorization the install path applies must therefore bind IDENTITY,
//! not just bytes: the release's SIGNED manifest (`latest.json` +
//! `latest.json.sig`, same pinned key) names the version, the asset filename
//! and the signature for those exact bytes; the version must be strictly newer
//! than the RUNNING build (re-asserted at install, not only at check time) and
//! never below the monotonic floor this install already reached.

use base64::Engine as _;

use lighthouse_core::updates::{
    authorize_update, read_update_floor, record_update_floor, verify_update_signature,
};

const RUNNING: &str = "0.14.20"; // the build under attack

fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

/// A keypair + signatures laid out the way CI's `tauri signer sign` does:
/// base64 of the full minisign key/signature files.
fn keypair() -> minisign::KeyPair {
    minisign::KeyPair::generate_unencrypted_keypair().expect("keypair")
}

fn pubkey_of(kp: &minisign::KeyPair) -> String {
    b64(&kp.pk.to_box().expect("pk box").into_string())
}

fn sign(kp: &minisign::KeyPair, data: &[u8]) -> String {
    b64(&minisign::sign(
        None,
        &kp.sk,
        std::io::Cursor::new(data),
        Some("lighthouse test sig"),
        None,
    )
    .expect("sign")
    .into_string())
}

/// The manifest CI publishes beside the installers (`latest.json`): the
/// version, and per platform the asset URL + the signature of its bytes.
fn manifest(version: &str, asset: &str, asset_sig: &str) -> Vec<u8> {
    serde_json::json!({
        "version": version,
        "notes": format!("https://github.com/lmansf/lighthouse/releases/tag/v{version}"),
        "pub_date": "2026-08-01T00:00:00Z",
        "platforms": {
            "linux-x86_64": {
                "signature": asset_sig,
                "url": format!(
                    "https://github.com/lmansf/lighthouse/releases/download/v{version}/{asset}"
                ),
            }
        }
    })
    .to_string()
    .into_bytes()
}

/// One release, exactly as it shipped — nothing forged anywhere.
struct Release {
    name: String,
    bytes: Vec<u8>,
    sig: String,
    manifest: Vec<u8>,
    manifest_sig: String,
}

fn release(kp: &minisign::KeyPair, version: &str) -> Release {
    let name = format!("Lighthouse_{version}_amd64.AppImage");
    let bytes = format!("Lighthouse {version} AppImage bytes").into_bytes();
    let sig = sign(kp, &bytes);
    let manifest = manifest(version, &name, &sig);
    let manifest_sig = sign(kp, &manifest);
    Release {
        name,
        bytes,
        sig,
        manifest,
        manifest_sig,
    }
}

#[test]
fn a_genuinely_signed_older_build_cannot_be_installed_under_a_newer_tag() {
    let kp = keypair();
    let pubkey = pubkey_of(&kp);
    let old = release(&kp, "0.10.0");

    // Bytes-only verification — the ONLY authorization the install path used to
    // apply — says yes, and always will: the signature is genuine.
    verify_update_signature(&old.bytes, &old.sig, &pubkey)
        .expect("the old release's own signature is genuine — bytes alone can never refuse it");

    // Re-published under tag v9.9.9 (a tag is attacker-chosen and unsigned).
    // The install must refuse: the SIGNED manifest still says 0.10.0, and the
    // running build is newer.
    let err = authorize_update(
        &old.manifest,
        &old.manifest_sig,
        &pubkey,
        RUNNING,
        None,
        &old.name,
    )
    .expect_err("a signed-but-older release must never be installable");
    assert!(
        format!("{err}").contains("0.10.0"),
        "the refusal names the version it refused: {err}"
    );
}

#[test]
fn the_next_real_release_is_authorized_and_binds_the_bytes_it_names() {
    let kp = keypair();
    let pubkey = pubkey_of(&kp);
    let next = release(&kp, "0.14.21");

    let ok = authorize_update(
        &next.manifest,
        &next.manifest_sig,
        &pubkey,
        RUNNING,
        None,
        &next.name,
    )
    .expect("the genuine next release still installs");
    assert_eq!(ok.version, "0.14.21");

    // The signature handed back is the manifest's, and it accepts ONLY the
    // bytes that manifest attests — swapping in an older release's genuine
    // artifact fails here even though its own `.sig` is valid.
    verify_update_signature(&next.bytes, &ok.signature, &pubkey)
        .expect("the attested signature verifies the attested bytes");
    let old = release(&kp, "0.10.0");
    assert!(
        verify_update_signature(&old.bytes, &ok.signature, &pubkey).is_err(),
        "bytes the manifest does not attest must fail"
    );
}

#[test]
fn an_unattested_asset_or_an_edited_manifest_is_refused() {
    let kp = keypair();
    let pubkey = pubkey_of(&kp);
    let next = release(&kp, "0.14.21");

    // Filename binding: the manifest attests the AppImage, not some other asset
    // a publisher added to the release.
    assert!(
        authorize_update(
            &next.manifest,
            &next.manifest_sig,
            &pubkey,
            RUNNING,
            None,
            "Lighthouse-Setup.exe",
        )
        .is_err(),
        "an asset the manifest does not name must not be installable"
    );

    // Editing the version inside the signed manifest breaks its signature.
    let edited = String::from_utf8(next.manifest.clone())
        .unwrap()
        .replace("0.14.21", "9.9.9")
        .into_bytes();
    assert!(
        authorize_update(
            &edited,
            &next.manifest_sig,
            &pubkey,
            RUNNING,
            None,
            &next.name
        )
        .is_err(),
        "an edited manifest must fail its signature"
    );

    // A manifest signed by a DIFFERENT key is not ours.
    let other = keypair();
    assert!(
        authorize_update(
            &next.manifest,
            &sign(&other, &next.manifest),
            &pubkey,
            RUNNING,
            None,
            &next.name,
        )
        .is_err(),
        "only the pinned key may authorize an install"
    );

    // Garbage in place of a manifest → a clean error, no panic.
    assert!(authorize_update(
        b"not json",
        &next.manifest_sig,
        &pubkey,
        RUNNING,
        None,
        &next.name
    )
    .is_err());
}

#[test]
fn the_floor_is_monotonic_and_refuses_a_superseded_release() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        read_update_floor(dir.path()),
        None,
        "no floor before an install"
    );

    record_update_floor(dir.path(), "0.14.21");
    assert_eq!(read_update_floor(dir.path()).as_deref(), Some("0.14.21"));
    // Never rewinds: an older or unparseable version leaves the floor alone.
    record_update_floor(dir.path(), "0.10.0");
    record_update_floor(dir.path(), "not-a-version");
    assert_eq!(read_update_floor(dir.path()).as_deref(), Some("0.14.21"));

    // A build rolled back to 0.14.19 would otherwise accept a genuine 0.14.20
    // (it IS newer than what is running) — but 0.14.20 is superseded, and the
    // floor remembers.
    let kp = keypair();
    let pubkey = pubkey_of(&kp);
    let superseded = release(&kp, "0.14.20");
    let floor = read_update_floor(dir.path());
    assert!(
        authorize_update(
            &superseded.manifest,
            &superseded.manifest_sig,
            &pubkey,
            "0.14.19",
            floor.as_deref(),
            &superseded.name,
        )
        .is_err(),
        "a release below the floor must never be re-offered"
    );

    // …while the floor version itself still installs, so a failed install can
    // be retried.
    let retry = release(&kp, "0.14.21");
    assert!(
        authorize_update(
            &retry.manifest,
            &retry.manifest_sig,
            &pubkey,
            "0.14.19",
            floor.as_deref(),
            &retry.name,
        )
        .is_ok(),
        "retrying the floor version is not a downgrade"
    );
}
