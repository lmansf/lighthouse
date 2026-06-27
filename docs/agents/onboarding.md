# Agent brief: onboarding

## Scope (yours)
- `src/features/onboarding/` only. Replace the `OnboardingPanel.tsx` placeholder with the full flow.

This renders inside the shell's left rail.

## Contract you implement against
- Drive `src/stores/useAuthStore.ts` (`signIn`, `register`, `selectModel`, `completeOnboarding`, `signOut`).
- The store wraps `AuthService` (`src/contracts/services.ts`) - a real local-first impl (`/api/profile`-backed) today, with a swappable in-memory mock and a cloud provider later. Code to the store, not the impl.
- Provider list + per-provider API-key URLs come from `MODEL_PROVIDERS` (`@/contracts`). Each provider's `apiKeyUrl` deep-links the user to where they generate a key.

## What to build
1. **Sign-in / registration** as multiple slides (welcome → credentials → confirm). Keep each slide focused; animate between them.
2. **Model-select onboarding**: pick a primary provider, then a model within it, then paste an API key. Show a contextual "Get your {provider} key →" link (`provider.apiKeyUrl`) that opens in a new tab.
3. On completion, show a compact signed-in summary (name, provider · model, sign out).

## Acceptance criteria
- All steps reflect `onboarding.step` from the store and survive a refresh-driven re-read (`refresh()`).
- The key field never logs the raw key client-side or exposes it beyond the store's `hasApiKey` flag (the local backend persists it to `vault/.rag-vault/profile.json`, gitignored).
- Provider/model dropdowns are driven entirely by `MODEL_PROVIDERS` (adding a provider there requires no code change here).
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`. No hardcoded colors.
- Don't import explorer/chat/shell internals.
