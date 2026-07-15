# Agent brief: onboarding

## Scope (yours)
- `src/features/onboarding/` only. Replace the `OnboardingPanel.tsx` placeholder with the full flow.

This renders full-screen (centered) before the sidebar + chat workspace appears.

## Contract you implement against
- Drive `src/stores/useAuthStore.ts` (`finishVault`, `finishMode`, `selectModel`, `setDefaultInclusion`, `completeOnboarding`, `signOut`).
- The store wraps `AuthService` (`src/contracts/services.ts`) - a real local-first impl (`/api/profile`-backed) today, with a swappable in-memory mock and a cloud provider later. Code to the store, not the impl.
- Provider list + per-provider API-key URLs come from `MODEL_PROVIDERS` (`@/contracts`). Each provider's `apiKeyUrl` deep-links the user to where they generate a key — except the `local` ("Local model (private)") provider, which runs on-device and needs no key (its `apiKeyUrl` points at setup docs).

## What to build
Lighthouse has no accounts — first run is **vault → window/widget mode → model → default inclusion**, with no email or registration:
1. **Vault**: confirm where the user's documents live (they change the folder from the native File → "Choose vault folder…" menu). On the web twin there is no picker — just proceed.
2. **Mode** (desktop only): the window-vs-widget choice (reuses `ModeChooserAuto`); the web twin auto-advances.
3. **Model-select**: pick a primary provider, then a model within it, then paste an API key. The `local` ("Local model (private)") provider is first in `MODEL_PROVIDERS` and so is the **default selection** on first run (private by default); the user can still switch to a hosted provider. Show a contextual "Get your {provider} key →" link (`provider.apiKeyUrl`) that opens in a new tab. The `local` provider hides the key field entirely (no key required).
4. **Default inclusion**: choose whether newly-added files start included or excluded, then finish.

## Acceptance criteria
- All steps reflect `onboarding.step` from the store and survive a refresh-driven re-read (`refresh()`).
- The key field never logs the raw key client-side or exposes it beyond the store's `hasApiKey` flag (the local backend persists it to `vault/.rag-vault/profile.json`, gitignored).
- Provider/model dropdowns are driven entirely by `MODEL_PROVIDERS` (adding a provider there requires no code change here).
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`. No hardcoded colors.
- Don't import explorer/chat/shell internals.
