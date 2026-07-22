/**
 * §3 (iOS field patch 1) pinned verdicts: the private local model exists ONLY
 * on the desktop shell, and every layer answers mobile the same way —
 *
 *   - localModelSupported: the ONE pure verdict (engine guard for
 *     modelStatus/startDownload, synth's warm-wait short-circuit). KEEP IN
 *     SYNC with the Rust pin local_model.rs::local_model_supported_only_on_desktop.
 *   - defaultProviderFor: a mobile profile defaults to NO provider (the
 *     deterministic device path still answers); desktop keeps the historic
 *     private-local default. KEEP IN SYNC with
 *     profile.rs::default_provider_is_platform_aware.
 *   - modelProvidersFor: the availability-driven UI roster — the local entry is
 *     GONE on a mobile shell WITHOUT a backend, and returns (local leading) when
 *     one is reported (add-mobile-local-inference). The model slide, Settings →
 *     AI models and the chat header switcher all consume this one filter.
 *   - ON_DEVICE_MODEL_COPY: the byte-pinned per-tier description for the
 *     on-device model when it IS available on a mobile shell.
 *   - MOBILE_NO_PROVIDER_TRUTHS: the empty-provider state's exact two truths,
 *     byte-pinned because the same sentence appears on several surfaces.
 *
 * Run: `node --test test/localModelPlatform.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { localModelSupported, localModelAvailable, setOnDeviceBackend, onDeviceBackend } =
  await import("../src/server/localModel.ts");
const { defaultProviderFor } = await import("../src/server/profile.ts");
const { MODEL_PROVIDERS, MOBILE_NO_PROVIDER_TRUTHS, ON_DEVICE_MODEL_COPY, modelProvidersFor } =
  await import("../src/contracts/mocks/providers.ts");

test("localModelSupported: the no-backend verdict is desktop only", () => {
  assert.equal(localModelSupported("desktop"), true);
  assert.equal(localModelSupported("ios"), false);
  assert.equal(localModelSupported("android"), false);
  assert.equal(localModelSupported(""), false);
  assert.equal(localModelSupported("web"), false);
});

test("localModelAvailable: mobile lights up ONLY with a reported on-device backend", () => {
  // Desktop is always available — the backend flag is moot there.
  assert.equal(localModelAvailable("desktop", false), true);
  assert.equal(localModelAvailable("desktop", true), true);
  // add-mobile-local-inference: a mobile shell is available iff a backend exists.
  assert.equal(localModelAvailable("ios", true), true);
  assert.equal(localModelAvailable("android", true), true);
  assert.equal(localModelAvailable("ios", false), false);
  assert.equal(localModelAvailable("android", false), false);
  // Unknown fails closed.
  assert.equal(localModelAvailable("web", true), false);
});

test("onDeviceBackend: defaults false, settable by the shell", () => {
  assert.equal(onDeviceBackend(), false, "fails closed until the plugin reports a backend");
  setOnDeviceBackend(true);
  assert.equal(onDeviceBackend(), true);
  setOnDeviceBackend(false); // restore the module default for the other tests
  assert.equal(onDeviceBackend(), false);
});

test("defaultProviderFor: private-local on desktop and on a mobile shell WITH a backend", () => {
  const local = { providerId: "local", modelId: "lighthouse-local" };
  assert.deepEqual(defaultProviderFor("desktop", false), local);
  assert.deepEqual(defaultProviderFor("desktop", true), local);
  assert.deepEqual(defaultProviderFor("ios", true), local);
  assert.deepEqual(defaultProviderFor("android", true), local);
  // No backend on mobile → NO provider (the deterministic device path answers).
  assert.deepEqual(defaultProviderFor("ios", false), { providerId: null, modelId: null });
  assert.deepEqual(defaultProviderFor("android", false), { providerId: null, modelId: null });
});

test("modelProvidersFor: availability-driven — desktop full, mobile local iff a backend", () => {
  // Desktop is the untouched catalog — same array, local still leads. The
  // backend flag is moot there (the `desktop` short-circuit wins).
  assert.equal(modelProvidersFor("desktop"), MODEL_PROVIDERS);
  assert.equal(modelProvidersFor("desktop", false), MODEL_PROVIDERS);
  assert.equal(MODEL_PROVIDERS[0].id, "local", "catalog invariant: local leads on desktop");

  const cloudOnly = MODEL_PROVIDERS.filter((p) => p.id !== "local").map((p) => p.id);

  // No backend (default arg AND explicit false) → local is GONE on mobile,
  // every cloud vendor surviving in catalog order.
  for (const roster of [modelProvidersFor("ios"), modelProvidersFor("ios", false)]) {
    assert.ok(!roster.some((p) => p.id === "local"), "ios without a backend: local must be GONE");
    assert.deepEqual(roster.map((p) => p.id), cloudOnly);
  }

  // add-mobile-local-inference: a reported backend brings local back — the FULL
  // catalog, local leading, exactly like desktop.
  for (const platform of ["ios", "android"]) {
    const roster = modelProvidersFor(platform, true);
    assert.equal(roster[0].id, "local", `${platform} with a backend: local must lead`);
    assert.deepEqual(
      roster.map((p) => p.id),
      MODEL_PROVIDERS.map((p) => p.id),
      `${platform} with a backend: the full catalog returns`,
    );
  }
});

test("the mobile empty-provider copy says exactly the two truths", () => {
  // §33 §3: availability-driven — the state only exists when no on-device
  // backend reported, so the truth is about THIS device, not "the desktop app"
  // (stale since the Foundation-Models bridge landed).
  assert.equal(
    MOBILE_NO_PROVIDER_TRUTHS,
    "Add a cloud API key to enable narrated answers — the on-device private model isn't available on this device.",
  );
});

test("ON_DEVICE_MODEL_COPY: the per-tier on-device descriptions are byte-exact", () => {
  assert.equal(ON_DEVICE_MODEL_COPY.foundation, "Runs on this device using Apple's on-device model");
  assert.equal(ON_DEVICE_MODEL_COPY.gguf, "Runs on this device using a built-in private model");
});
