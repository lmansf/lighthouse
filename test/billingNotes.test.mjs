// Billing-clarity notes (0.12.1 §4): the copy is static and per-vendor. These
// tests pin the two invariants that matter — the private model never carries a
// billing note, and every cloud vendor's key note names a subscription and
// disclaims it — plus that the surfaces render the notes from the shared module
// (no hand-inlined copy that could drift).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiKeyBillingNote, signinBillingNote } from "../src/lib/billingNotes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// The cloud vendors that appear in the model picker (contracts/mocks/providers.ts).
const CLOUD = ["anthropic", "openai", "google", "xai", "mistral", "deepseek"];

test("the private on-device model never carries a billing note", () => {
  assert.equal(apiKeyBillingNote("local"), null);
  assert.equal(apiKeyBillingNote(null), null);
  assert.equal(apiKeyBillingNote(undefined), null);
  assert.equal(signinBillingNote("local"), null);
});

test("every cloud vendor's key note names its subscription and disclaims it", () => {
  for (const id of CLOUD) {
    const note = apiKeyBillingNote(id);
    assert.ok(note, `${id} has a key note`);
    assert.match(note, /API keys bill per use/, `${id} states per-use billing`);
    assert.match(note, /does NOT cover API-key usage/, `${id} disclaims the subscription`);
  }
});

test("the OpenAI key note names ChatGPT; sign-in note points at the account", () => {
  assert.match(apiKeyBillingNote("openai"), /ChatGPT Plus, Pro, or Team/);
  // Sign-in copy exists only where §3 offers sign-in (OpenAI today).
  assert.match(signinBillingNote("openai"), /draws on your ChatGPT account/);
  assert.equal(signinBillingNote("anthropic"), null);
});

test("an unknown provider yields no note (never a broken/blank line)", () => {
  assert.equal(apiKeyBillingNote("acme"), null);
  assert.equal(signinBillingNote("acme"), null);
});

test("all three picker surfaces render the note from the shared module", () => {
  // No hand-inlined billing copy: each surface imports and calls the helper.
  const settings = read("src/features/settings/SettingsMenu.tsx");
  assert.match(settings, /apiKeyBillingNote, signinBillingNote \} from "@\/lib\/billingNotes"/);
  assert.match(settings, /apiKeyBillingNote\(providerId\)/);
  assert.match(settings, /signinBillingNote\(providerId\)/);

  const onboarding = read("src/features/onboarding/OnboardingPanel.tsx");
  assert.match(onboarding, /apiKeyBillingNote \} from "@\/lib\/billingNotes"/);
  assert.match(onboarding, /apiKeyBillingNote\(providerId\)/);

  const picker = read("src/features/chat/ProviderSwitch.tsx");
  assert.match(picker, /apiKeyBillingNote \} from "@\/lib\/billingNotes"/);
  assert.match(picker, /apiKeyBillingNote\(onboarding\.providerId\)/);

  // Static copy, no telemetry: the module opens no socket and counts nothing.
  const mod = read("src/lib/billingNotes.ts");
  assert.doesNotMatch(mod, /fetch\(|record\(|track\(|analytics/);
});
