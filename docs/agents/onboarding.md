# Agent brief: onboarding

## Scope (yours)
- `src/features/onboarding/` only. Replace the `OnboardingPanel.tsx` placeholder with the full flow.

This renders inside the shell's left rail.

## Contract you implement against
- Drive `src/stores/useAuthStore.ts` (`signIn`, `register`, `selectModel`, `completeOnboarding`, `signOut`).
- The store wraps `AuthService` (`src/contracts/services.ts`) - mocked today, real provider later. Code to the store, not the mock.
- Provider list + per-provider API-key URLs come from `MODEL_PROVIDERS` (`@/contracts`). Each provider's `apiKeyUrl` deep-links the user to where they generate a key.

## What to build
1. **Sign-in / registration** as multiple slides (welcome → credentials → confirm). Keep each slide focused; animate between them.
2. **Model-select onboarding**: pick a primary provider, then a model within it, then paste an API key. Show a contextual "Get your {provider} key →" link (`provider.apiKeyUrl`) that opens in a new tab.
3. On completion, show a compact signed-in summary (name, provider · model, sign out).

## Acceptance criteria
- All steps reflect `onboarding.step` from the store and survive a refresh-driven re-read (`refresh()`).
- The key field never logs or persists the raw key beyond the mock's `hasApiKey` flag.
- Provider/model dropdowns are driven entirely by `MODEL_PROVIDERS` (adding a provider there requires no code change here).
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`. No hardcoded colors.
- Don't import explorer/chat/shell internals.
