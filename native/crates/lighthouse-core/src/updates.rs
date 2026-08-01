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
//! A signature binds BYTES to the key — never bytes to a VERSION. The release's
//! SIGNED manifest (`latest.json` + `latest.json.sig`) is what binds the two,
//! and `authorize_update` is the gate the install path must pass before an
//! artifact can run (docs/signing.md, "Release manifest — the identity
//! binding").
//!
//! Format notes (Tauri v2 conventions):
//! - the `.sig` release asset contains BASE64 of a full minisign signature
//!   file (untrusted comment / sig / trusted comment / global sig);
//! - the public key is BASE64 of a full minisign public-key file.
//! Raw (un-base64'd) minisign content is accepted too, so hand-generated
//! keys/signatures verify the same way.

use std::path::{Component, Path, PathBuf};

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

/// Parse `x.y.z` into a comparable triple, tolerating a leading `v` and a
/// trailing pre-release tag (`0.15.0-rc1` → `(0,15,0)`). `None` for anything
/// unparseable, so a junk version can never read as newer. Lives here (not in
/// the shell, where it was check-time-only) because the comparison that
/// AUTHORIZES an install must be tauri-free and unit-tested.
pub fn version_tuple(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .ok()
    });
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

/// What a verified release manifest authorizes: the version it attests, and
/// the signature it names for the asset about to be installed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedUpdate {
    pub version: String,
    pub signature: String,
}

/// Authorize installing `asset_name` from a release, given that release's
/// SIGNED manifest (`latest.json` + `latest.json.sig`, signed with the same key
/// as the artifacts) — the gate `update_now` must pass before anything runs.
///
/// WHY (red-team 2026-08, "forced downgrade"): a minisign signature binds BYTES
/// to the key — never bytes to a VERSION. Whoever can write the release channel
/// (CI token, a maintainer PAT, compromised CI — the adversary
/// docs/auto-updater-design.md §2 already names) could re-publish an OLDER,
/// still validly-signed installer under a newer tag: the artifact verified
/// because it was genuine, so the app installed a superseded build and re-armed
/// every fix since while the banner read the higher version. The manifest is
/// the identity binding — it is signed, and it carries the version, this
/// platform's asset FILENAME (in its url) and the signature CI made for those
/// exact bytes.
///
/// Fails CLOSED on anything it cannot read. Refuses unless: the manifest
/// verifies against the pinned key; its version parses and is strictly greater
/// than `current` — the RUNNING build, re-asserted HERE and not merely at check
/// time, where the only version in hand was the attacker-chosen tag; the
/// version is not below the monotonic `floor` this install already reached; and
/// the manifest actually names `asset_name`. An unreadable `floor` is ignored
/// (the `> current` gate still stands), so a corrupt floor file cannot brick
/// updating.
pub fn authorize_update(
    manifest: &[u8],
    manifest_sig: &str,
    pubkey: &str,
    current: &str,
    floor: Option<&str>,
    asset_name: &str,
) -> Result<AuthorizedUpdate> {
    verify_update_signature(manifest, manifest_sig, pubkey)
        .context("update manifest failed signature verification")?;
    let doc: serde_json::Value =
        serde_json::from_slice(manifest).context("update manifest is not JSON")?;
    let version = doc["version"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    let (Some(new), Some(running)) = (version_tuple(&version), version_tuple(current)) else {
        return Err(anyhow!(
            "unreadable update version (manifest {version:?}, running {current:?})"
        ));
    };
    if new <= running {
        return Err(anyhow!(
            "refusing update {version}: not newer than the running build {current}"
        ));
    }
    if let Some(floor) = floor {
        if version_tuple(floor).is_some_and(|f| new < f) {
            return Err(anyhow!(
                "refusing update {version}: superseded — this install already authorized {floor}"
            ));
        }
    }
    // Bind the FILENAME too: the manifest must name the very asset we are about
    // to install, and the signature handed back is the one IT attests — not the
    // loose `<asset>.sig`, which a release publisher can swap for another
    // genuine one.
    let want = asset_name.trim().to_ascii_lowercase();
    let signature = doc["platforms"]
        .as_object()
        .and_then(|entries| {
            entries.values().find_map(|e| {
                let file = e["url"].as_str()?.rsplit('/').next()?.to_ascii_lowercase();
                (file == want)
                    .then(|| e["signature"].as_str().map(str::to_string))
                    .flatten()
            })
        })
        .ok_or_else(|| anyhow!("update manifest {version} does not attest asset {asset_name}"))?;
    Ok(AuthorizedUpdate { version, signature })
}

/// The monotonic downgrade floor, kept beside the staged download in the
/// app-data updates dir (`supervise.rs::update_now`'s `dir`).
fn floor_file(dir: &Path) -> PathBuf {
    dir.join("install-floor.json")
}

/// The highest version this install has ever authorized, if one was recorded.
pub fn read_update_floor(dir: &Path) -> Option<String> {
    let recorded: String = crate::config::read_json(&floor_file(dir), String::new());
    let recorded = recorded.trim().to_string();
    (!recorded.is_empty()).then_some(recorded)
}

/// Raise the floor to `version` — MONOTONIC: an older or unparseable version
/// never lowers it, so a build that was downgraded (or a bundle rolled back by
/// hand) cannot rewind the guard and let a superseded release be re-offered.
/// Best-effort and atomic (`config::write_json`); a failed write leaves the
/// previous floor in place and `authorize_update`'s `> current` gate still
/// stands on its own.
pub fn record_update_floor(dir: &Path, version: &str) {
    let Some(new) = version_tuple(version) else {
        return;
    };
    if read_update_floor(dir)
        .and_then(|v| version_tuple(&v))
        .is_some_and(|cur| new <= cur)
    {
        return;
    }
    crate::config::write_json(&floor_file(dir), &version.trim().to_string());
}

/// The platform an update is being picked for — passed in (not read from
/// `cfg!`) so the choice is a pure, per-platform table the tests pin, off any
/// real host (CONVENTIONS "the pure verdict-fn pattern").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdatePlatform {
    Windows,
    Macos,
    Linux,
}

/// How the shell installs a picked asset — the verdict that drives
/// `update_now`'s per-platform arm. A `.deb` is deliberately absent: it can't
/// self-install in place (needs `dpkg`/root), so it stays notify-only and
/// `pick_update_asset` returns `None` for a `.deb`-only Linux release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    /// Windows NSIS installer (`.exe`): halt children → run installer → exit.
    WindowsInstaller,
    /// macOS updater archive (`.app.tar.gz`): unpack + in-place bundle swap +
    /// relaunch — the "feels automatic" path.
    MacAppArchive,
    /// macOS disk image (`.dmg`): opened for a manual drag — the FALLBACK when
    /// no signed `.app.tar.gz` is present (e.g. an unsigned release).
    MacDmg,
    /// Linux AppImage: `chmod +x` + swap the file in place.
    LinuxAppImage,
}

/// One picked update asset: the release-asset filename to download, and how to
/// install it once verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickedAsset {
    pub name: String,
    pub kind: InstallKind,
}

/// Choose which release asset this platform installs in place, and how — the
/// pure verdict behind the shell's per-platform install. `asset_names` are the
/// release's asset filenames (any case; `.sig` siblings are ignored by the
/// suffix match). Returns `None` when nothing on the release can self-install
/// here — the caller then stays notify-only (open the releases page):
///   - **Linux** with only a `.deb` (needs `dpkg`/root): download the `.deb`;
///   - a platform whose installer asset is simply absent.
/// **macOS PREFERS the `.app.tar.gz`** (verified in-place bundle swap) and falls
/// back to the `.dmg` (manual drag) only when the archive is absent — an
/// unsigned release carries no `.app.tar.gz`, so it correctly degrades to the
/// dmg-open path.
pub fn pick_update_asset(platform: UpdatePlatform, asset_names: &[String]) -> Option<PickedAsset> {
    // A `.sig` sibling (e.g. `foo.exe.sig`) never matches an installer suffix,
    // so detached signatures are transparently skipped.
    let find = |suffix: &str| -> Option<String> {
        asset_names
            .iter()
            .find(|n| n.to_ascii_lowercase().ends_with(suffix))
            .cloned()
    };
    match platform {
        UpdatePlatform::Windows => find(".exe").map(|name| PickedAsset {
            name,
            kind: InstallKind::WindowsInstaller,
        }),
        UpdatePlatform::Macos => {
            if let Some(name) = find(".app.tar.gz") {
                Some(PickedAsset { name, kind: InstallKind::MacAppArchive })
            } else {
                find(".dmg").map(|name| PickedAsset { name, kind: InstallKind::MacDmg })
            }
        }
        // AppImage self-updates in place; a `.deb` cannot, so a release with
        // ONLY a `.deb` returns None (notify-only) — pinned by test.
        UpdatePlatform::Linux => find(".appimage").map(|name| PickedAsset {
            name,
            kind: InstallKind::LinuxAppImage,
        }),
    }
}

/// Where a picked asset is allowed to land while it stages for verification.
/// The asset NAME comes off the release manifest — remote, unauthenticated, and
/// written to disk strictly BEFORE the minisign gate can run — so it never gets
/// to choose a path: `pick_update_asset` above constrains only the SUFFIX,
/// which leaves `/etc/cron.d/x.exe` and `../../../x.AppImage` perfectly valid
/// "assets". Joined naively those are an arbitrary-file create+truncate (and,
/// on the failure arms, delete) outside anything the pinned key protects — a
/// signature-gate bypass that needs no signing key (§56 #2).
///
/// Accepted only when `asset_name` is exactly ONE plain filename: no separator
/// of either flavour (a Windows `..\x.exe` parses as a single innocent-looking
/// component on Unix, so both are refused as STRINGS first), no NUL, and then
/// exactly one `Component::Normal` and nothing more — which rules out
/// `RootDir`/`Prefix` (absolute, `C:\`, UNC), `ParentDir` and `CurDir`.
/// Anything else is `None` and the caller stays notify-only. Note the component
/// check is the real gate, not the `starts_with` re-check below it: path
/// comparison is LEXICAL, so `<dir>/../x` does "start with" `<dir>`. The
/// re-check is still a genuine second net on Windows, where a drive-relative
/// `C:foo.exe` is the one shape whose push discards the base.
pub fn staging_path(dir: &Path, asset_name: &str) -> Option<PathBuf> {
    if asset_name.is_empty()
        || asset_name.contains('/')
        || asset_name.contains('\\')
        || asset_name.contains('\0')
    {
        return None;
    }
    let mut comps = Path::new(asset_name).components();
    let file = match (comps.next(), comps.next()) {
        (Some(Component::Normal(n)), None) => n,
        _ => return None,
    };
    let dest = dir.join(file);
    dest.starts_with(dir).then_some(dest)
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

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pick_update_asset_is_a_per_platform_table() {
        use InstallKind::*;
        use UpdatePlatform::*;
        // A full signed release: every platform's installer + its .sig + the
        // manifests. Each platform picks ITS installer, never a .sig sibling.
        let full = names(&[
            "Lighthouse-Setup.exe",
            "Lighthouse-Setup.exe.sig",
            "Lighthouse_0.14.19_x64.dmg",
            "Lighthouse.app.tar.gz",
            "Lighthouse.app.tar.gz.sig",
            "Lighthouse_0.14.19_amd64.AppImage",
            "Lighthouse_0.14.19_amd64.AppImage.sig",
            "lighthouse_0.14.19_amd64.deb",
            "latest.json",
            "latest.yml",
            "latest-mac.yml",
        ]);
        assert_eq!(
            pick_update_asset(Windows, &full),
            Some(PickedAsset { name: "Lighthouse-Setup.exe".into(), kind: WindowsInstaller })
        );
        // macOS PREFERS the .app.tar.gz over the .dmg (verified in-place swap).
        assert_eq!(
            pick_update_asset(Macos, &full),
            Some(PickedAsset { name: "Lighthouse.app.tar.gz".into(), kind: MacAppArchive })
        );
        assert_eq!(
            pick_update_asset(Linux, &full),
            Some(PickedAsset {
                name: "Lighthouse_0.14.19_amd64.AppImage".into(),
                kind: LinuxAppImage,
            })
        );
    }

    #[test]
    fn macos_falls_back_to_dmg_when_no_app_archive() {
        use InstallKind::*;
        use UpdatePlatform::*;
        // Unsigned release: no .app.tar.gz, only the first-install .dmg.
        let unsigned_mac = names(&["Lighthouse_0.14.19_x64.dmg"]);
        assert_eq!(
            pick_update_asset(Macos, &unsigned_mac),
            Some(PickedAsset { name: "Lighthouse_0.14.19_x64.dmg".into(), kind: MacDmg })
        );
    }

    #[test]
    fn deb_only_linux_is_notify_only_and_deb_is_never_picked() {
        use InstallKind::LinuxAppImage;
        use UpdatePlatform::*;
        // A Linux release with ONLY a .deb → not installable in place (None).
        assert_eq!(pick_update_asset(Linux, &names(&["app_0.14.19_amd64.deb"])), None);
        // AppImage alongside the .deb → still the AppImage, never the .deb.
        let both = names(&["app_0.14.19_amd64.AppImage", "app_0.14.19_amd64.deb"]);
        assert_eq!(pick_update_asset(Linux, &both).unwrap().kind, LinuxAppImage);
    }

    #[test]
    fn absent_installer_is_none_and_match_is_case_insensitive() {
        use UpdatePlatform::*;
        // No matching installer → None for every platform (notify-only).
        assert_eq!(pick_update_asset(Windows, &names(&["latest.json"])), None);
        assert_eq!(pick_update_asset(Macos, &names(&[])), None);
        assert_eq!(pick_update_asset(Linux, &names(&["notes.txt"])), None);
        // Case-insensitive suffix match.
        assert_eq!(
            pick_update_asset(Linux, &names(&["Lighthouse.AppImage"])).unwrap().name,
            "Lighthouse.AppImage"
        );
    }
}
