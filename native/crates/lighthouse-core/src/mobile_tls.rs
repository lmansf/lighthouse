//! Mobile TLS root discovery — add-mobile-apps §1.2 de-risking spike.
//!
//! On desktop/host, reqwest's `rustls-tls-native-roots` reads the OS trust
//! store correctly, so nothing here changes desktop behavior — the entire
//! mobile branch is `cfg`-compiled away off the mobile triples, and the
//! non-mobile `async_client()` is byte-equivalent to the previous
//! `reqwest::Client::new()`.
//!
//! On Android, `rustls-native-certs` is known-broken (it cannot enumerate the
//! system CA store), so a client built with `rustls-tls-native-roots` there has
//! an empty root set and every HTTPS handshake fails. On the mobile targets we
//! instead hand reqwest a rustls `ClientConfig` whose certificate verifier is
//! `rustls-platform-verifier` — the platform's own verification (SecTrust on
//! Apple, the Android framework `X509TrustManager` via JNI). The ring provider
//! is pinned explicitly so this does not depend on a process-wide default
//! `CryptoProvider` being installed first.
//!
//! Spike scope: this proves the swap *compiles and links* for
//! `aarch64-apple-ios` and `aarch64-linux-android` (the Cargo.lock's `rustls`
//! is 0.23 with `ring`, which `rustls-platform-verifier` 0.5 targets, so the
//! two unify to one `rustls` instance). Proving a *live* HTTPS handshake from a
//! booted simulator/emulator is the deferred part of §1.2.
//!
//! PARITY: mobile binds the Rust engine only; the TS twin (`src/server/`) is
//! untouched by this.

/// One reqwest async client with mobile-appropriate TLS roots. Off-mobile this
/// is exactly `reqwest::Client::builder().build()` (== `Client::new()`); on the
/// mobile triples it carries the platform-verifier rustls config.
pub(crate) fn async_client() -> reqwest::Client {
    let builder = reqwest::Client::builder();
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.use_preconfigured_tls(mobile_tls_config());
    builder.build().expect("build reqwest client")
}

/// Build a rustls `ClientConfig` that verifies server certs through the OS
/// platform verifier. Mobile targets only.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn mobile_tls_config() -> rustls::ClientConfig {
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("rustls safe default protocol versions")
        .with_platform_verifier()
        .with_no_client_auth()
}
