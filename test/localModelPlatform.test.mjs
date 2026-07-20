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
 *   - modelProvidersFor: the UI roster drops the local entry entirely on
 *     mobile (GONE, not disabled) — the model slide, Settings → AI models and
 *     the chat header switcher all consume this one filter.
 *   - MOBILE_NO_PROVIDER_TRUTHS: the empty-provider state's exact two truths,
 *     byte-pinned because the same sentence appears on several surfaces.
 *
 * Run: `node --test test/localModelPlatform.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { localModelSupported } = await import("../src/server/localModel.ts");
const { defaultProviderFor } = await import("../src/server/profile.ts");
const { MODEL_PROVIDERS, MOBILE_NO_PROVIDER_TRUTHS, modelProvidersFor } = await import(
  "../src/contracts/mocks/providers.ts"
);

test("localModelSupported: desktop only, everything else fails closed", () => {
  assert.equal(localModelSupported("desktop"), true);
  assert.equal(localModelSupported("ios"), false);
  assert.equal(localModelSupported("android"), false);
  assert.equal(localModelSupported(""), false);
  assert.equal(localModelSupported("web"), false);
});

test("defaultProviderFor: private-local on desktop, NO provider on mobile", () => {
  assert.deepEqual(defaultProviderFor("desktop"), {
    providerId: "local",
    modelId: "lighthouse-local",
  });
  assert.deepEqual(defaultProviderFor("ios"), { providerId: null, modelId: null });
  assert.deepEqual(defaultProviderFor("android"), { providerId: null, modelId: null });
});

test("modelProvidersFor: desktop keeps the full catalog, mobile drops ONLY local", () => {
  // Desktop is the untouched catalog — same array, local still leads.
  assert.equal(modelProvidersFor("desktop"), MODEL_PROVIDERS);
  assert.equal(MODEL_PROVIDERS[0].id, "local", "catalog invariant: local leads on desktop");

  for (const platform of ["ios", "android"]) {
    const roster = modelProvidersFor(platform);
    assert.ok(!roster.some((p) => p.id === "local"), `${platform}: local must be GONE`);
    // Every cloud vendor survives, in catalog order.
    assert.deepEqual(
      roster.map((p) => p.id),
      MODEL_PROVIDERS.filter((p) => p.id !== "local").map((p) => p.id),
    );
  }
});

test("the mobile empty-provider copy says exactly the two truths", () => {
  assert.equal(
    MOBILE_NO_PROVIDER_TRUTHS,
    "Add a cloud API key to enable narrated answers — the private model runs on the desktop app.",
  );
});
