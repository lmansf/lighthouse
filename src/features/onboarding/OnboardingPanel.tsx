"use client";

/**
 * [TEAM: onboarding] Left-rail onboarding flow, three slides driven by
 * `useAuthStore`: a welcome/email slide (no password — the local auth service
 * only ever uses the email, so we don't pretend to check one), an optional
 * registration slide, and a model-select slide where the user picks a
 * provider/model and pastes a key, with a contextual "get your key" link per
 * provider and a soft (never blocking) gate when the local model isn't
 * installed yet.
 */

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dropdown,
  Field,
  Input,
  Link,
  Option,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { MODEL_PROVIDERS } from "@/contracts";
import {
  LocalModelOption,
  LocalModelInstallPanel,
  useLocalModel,
} from "@/features/localModel/LocalModelOption";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLicenseStore } from "@/stores/useLicenseStore";
import { useRagStore } from "@/stores/useRagStore";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  // Quiet progress marker ("Step n of 3") so the user knows how much is left.
  stepLabel: { color: tokens.colorNeutralForeground3 },
  // Welcome-slide value bullets: a plain list, tightened so it reads as part
  // of the panel rather than document prose.
  bullets: {
    margin: "0",
    paddingLeft: tokens.spacingHorizontalXL,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  errorText: { color: tokens.colorStatusDangerForeground1 },
  warningText: { color: tokens.colorStatusWarningForeground2 },
  signedIn: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalL,
  },
  row: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
});

// Deliberately loose: just "something@something.tld". Real validation happens
// when mail is actually sent; this only catches obvious typos before submit.
const EMAIL_RE = /.+@.+\..+/;

/**
 * The select-model slide's primary action, with a soft gate for the local
 * model: if the private model isn't installed yet the user can still finish
 * (onboarding must never hard-block), but the button stops over-promising
 * ("Finish anyway") and a warning explains where to get the model later.
 * Split out as a component because `useLocalModel` polls `/api/model`, and
 * mounting it only on this slide keeps the earlier slides from polling.
 */
function FinishSetupButton({ providerId, disabled }: { providerId: string; disabled: boolean }) {
  const styles = useStyles();
  const { status, received, total } = useLocalModel();
  const localNotReady = providerId === "local" && status !== "ready";
  // Percent only when the total is known — early in a download it isn't yet.
  const pct = total ? ` — ${Math.min(100, Math.floor((received / total) * 100))}%` : "";

  return (
    <>
      {localNotReady && (
        <Text size={200} className={styles.warningText}>
          {status === "downloading"
            ? `The private model is still downloading${pct}. You can finish now and check on it later in Settings → AI models.`
            : "The private model isn't installed yet — install it above, or finish now and add it later in Settings → AI models."}
        </Text>
      )}
      {/* type=submit so the enclosing form's onSubmit (Enter or click) finishes. */}
      <Button appearance="primary" type="submit" disabled={disabled}>
        {localNotReady ? "Finish anyway" : "Finish setup"}
      </Button>
    </>
  );
}

export function OnboardingPanel() {
  const styles = useStyles();
  const onboarding = useAuthStore((s) => s.onboarding);
  const signIn = useAuthStore((s) => s.signIn);
  const finishRegistration = useAuthStore((s) => s.finishRegistration);
  const selectModel = useAuthStore((s) => s.selectModel);
  const setDefaultInclusion = useAuthStore((s) => s.setDefaultInclusion);
  const signOut = useAuthStore((s) => s.signOut);
  // Managed policy (add-managed-policy): null = unrestricted; a list means
  // only those providers may be selected (the engine rejects server-side).
  const allowedProviders = useRagStore((s) => s.policy?.locks.allowedProviders ?? null);
  const setStep = useAuthStore((s) => s.setStep);
  const startTrial = useLicenseStore((s) => s.startTrial);

  const [email, setEmail] = useState("");
  // Set on an invalid submit attempt (not while typing — no red flash mid-word);
  // cleared as soon as the address becomes valid again.
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState(MODEL_PROVIDERS[0].id);
  const [modelId, setModelId] = useState(MODEL_PROVIDERS[0].models[0]);
  const [apiKey, setApiKey] = useState("");

  // Welcome-registration form fields.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [city, setCity] = useState("");
  const [stateField, setStateField] = useState("");
  const [doNotContact, setDoNotContact] = useState(false);
  // Default-inclusion choice: whether newly-added files are searchable by
  // default. Pre-filled from the current effective default; the user can change
  // it. `touched` stops the background-loaded default from overwriting a choice.
  const [inclusionPref, setInclusionPref] = useState<"include" | "exclude">("include");
  const inclusionTouched = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const emailPrefilled = useRef(false);

  // Sync the radio to the effective default once the profile has loaded, unless
  // the user has already picked.
  useEffect(() => {
    if (!inclusionTouched.current && onboarding.defaultInclusion) {
      setInclusionPref(onboarding.defaultInclusion);
    }
  }, [onboarding.defaultInclusion]);

  // Prefill the registration email from the signed-in user, once.
  useEffect(() => {
    if (
      onboarding.step === "register" &&
      onboarding.user?.email &&
      !emailPrefilled.current
    ) {
      emailPrefilled.current = true;
      setRegEmail(onboarding.user.email);
    }
  }, [onboarding.step, onboarding.user]);

  const provider = MODEL_PROVIDERS.find((p) => p.id === providerId)!;

  async function submitSignIn() {
    if (!EMAIL_RE.test(email)) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    setSignInError(null);
    setSigningIn(true);
    try {
      // There is no password: the auth service is a local single-user profile
      // keyed by email alone (see auth.real.ts), so we don't collect one.
      await signIn(email, "");
    } catch {
      setSignInError(
        "Something went wrong signing you in. Check your connection and try again.",
      );
    } finally {
      setSigningIn(false);
    }
  }

  async function submitRegistration() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email: regEmail,
          doNotContact,
          city,
          state: stateField,
        }),
      });
      const result = await res.json().catch(() => null);
      if (result?.ok === false && result.reason === "rejected") {
        console.warn("Registration was rejected and not saved", result.detail);
      }
    } catch {
      /* network error — proceed regardless; the user can't be blocked here */
    }
    // Persist the include/exclude-by-default choice before advancing.
    await setDefaultInclusion(inclusionPref).catch(() => {});
    await finishRegistration();
    setSubmitting(false);
  }

  /** Commit the model choice (shared by the Finish button and Enter-to-submit). */
  function finishSetup() {
    if (providerId !== "local" && !apiKey) return;
    void selectModel(providerId, modelId, apiKey);
  }

  if (onboarding.step === "sign-in") {
    return (
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault();
          void submitSignIn();
        }}
      >
        <Text size={200} className={styles.stepLabel}>
          Step 1 of 3
        </Text>
        <Title3>Welcome</Title3>
        <ul className={styles.bullets}>
          <li>
            <Text>Your files stay on your machine.</Text>
          </li>
          <li>
            <Text>Chat with an AI grounded in your own documents.</Text>
          </li>
          <li>
            <Text>Free 14-day trial — no card needed.</Text>
          </li>
        </ul>
        <Field
          label="Email"
          validationMessage={
            emailInvalid ? "That doesn't look like an email address — check for typos." : undefined
          }
        >
          <Input
            value={email}
            onChange={(_, d) => {
              setEmail(d.value);
              // Clear the error the moment the address becomes valid, so the
              // red state doesn't linger after the user has fixed it.
              if (emailInvalid && EMAIL_RE.test(d.value)) setEmailInvalid(false);
            }}
            type="email"
          />
        </Field>
        <Button
          appearance="primary"
          type="submit"
          disabled={!email || signingIn}
          icon={signingIn ? <Spinner size="tiny" /> : undefined}
        >
          Continue
        </Button>
        {signInError && (
          <Text size={200} className={styles.errorText}>
            {signInError}
          </Text>
        )}
      </form>
    );
  }

  if (onboarding.step === "register") {
    return (
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault();
          if (submitting || !regEmail) return;
          void submitRegistration();
        }}
      >
        <Text size={200} className={styles.stepLabel}>
          Step 2 of 3
        </Text>
        <Title3>Welcome aboard</Title3>
        <Text className={styles.hint}>
          Tell us a little about you, or skip — it&apos;s optional.
        </Text>
        <Field label="First name">
          <Input value={firstName} onChange={(_, d) => setFirstName(d.value)} />
        </Field>
        <Field label="Last name">
          <Input value={lastName} onChange={(_, d) => setLastName(d.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={regEmail} onChange={(_, d) => setRegEmail(d.value)} />
        </Field>
        <Field label="City">
          <Input value={city} onChange={(_, d) => setCity(d.value)} />
        </Field>
        <Field label="State">
          <Input value={stateField} onChange={(_, d) => setStateField(d.value)} />
        </Field>
        <Checkbox
          checked={doNotContact}
          onChange={(_, d) => setDoNotContact(Boolean(d.checked))}
          label="Do not contact me"
        />
        <Field label="When you add files, should the AI see them by default?">
          <RadioGroup
            value={inclusionPref}
            onChange={(_, d) => {
              inclusionTouched.current = true;
              setInclusionPref(d.value === "exclude" ? "exclude" : "include");
            }}
          >
            <Radio
              value="include"
              label="Include everything by default — files are searchable as soon as you add them (toggle off anything you want to hide)"
            />
            <Radio
              value="exclude"
              label="Keep files out by default — nothing is searchable until you include it (more careful; you opt each one in)"
            />
          </RadioGroup>
        </Field>
        <Text className={styles.hint}>You can change this anytime; it only sets the starting point for files you add.</Text>
        <div className={styles.row}>
          <Button
            appearance="subtle"
            type="button"
            disabled={submitting}
            onClick={() => setStep("sign-in")}
          >
            Back
          </Button>
          <Button appearance="primary" type="submit" disabled={submitting || !regEmail}>
            Submit
          </Button>
          <Button
            appearance="subtle"
            type="button"
            disabled={submitting}
            onClick={() =>
              void (async () => {
                // Skipping still starts a trial (no contact info) so the user
                // isn't dropped straight onto the "trial ended" screen.
                await startTrial();
                await setDefaultInclusion(inclusionPref).catch(() => {});
                await finishRegistration();
              })()
            }
          >
            Skip
          </Button>
        </div>
      </form>
    );
  }

  if (onboarding.step === "select-model") {
    return (
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault();
          finishSetup();
        }}
      >
        <Text size={200} className={styles.stepLabel}>
          Step 3 of 3
        </Text>
        <Title3>Choose your model</Title3>
        <Text className={styles.hint}>
          {providerId === "local"
            ? "The local model runs entirely on your machine — no API key, nothing leaves your computer."
            : // The privacy tradeoff of a cloud model must be stated where the
              // choice is made, not buried in docs: retrieved excerpts of
              // AI-visible files leave the machine with every question.
              `Pick your primary model and add its API key. To answer questions, excerpts of the files you make visible are sent to ${provider.label}.`}
        </Text>
        <Field label="Provider">
          <Dropdown
            value={provider.label}
            selectedOptions={[providerId]}
            onOptionSelect={(_, d) => {
              const p = MODEL_PROVIDERS.find((x) => x.id === d.optionValue)!;
              setProviderId(p.id);
              setModelId(p.models[0]);
            }}
          >
            {MODEL_PROVIDERS.map((p) => (
              <Option
                key={p.id}
                value={p.id}
                text={p.label}
                // Managed policy: disallowed providers render disabled (the
                // engine rejects server-side regardless).
                disabled={allowedProviders ? !allowedProviders.includes(p.id) : false}
              >
                {p.id === "local" ? <LocalModelOption label={p.label} /> : p.label}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Model">
          <Dropdown
            value={modelId}
            selectedOptions={[modelId]}
            onOptionSelect={(_, d) => setModelId(d.optionValue!)}
          >
            {provider.models.map((m) => (
              <Option key={m} value={m}>
                {m}
              </Option>
            ))}
          </Dropdown>
        </Field>
        {providerId === "local" && <LocalModelInstallPanel />}
        {providerId !== "local" && (
          <Field
            label="API key"
            hint={
              <Link href={provider.apiKeyUrl} target="_blank" rel="noreferrer">
                Get your {provider.label} key →
              </Link>
            }
          >
            <Input
              value={apiKey}
              onChange={(_, d) => setApiKey(d.value)}
              type="password"
              placeholder="Paste your API key"
            />
          </Field>
        )}
        <FinishSetupButton providerId={providerId} disabled={providerId !== "local" && !apiKey} />
        <Button appearance="subtle" type="button" onClick={() => setStep("register")}>
          Back
        </Button>
      </form>
    );
  }

  // step === "done"
  return (
    <div className={styles.signedIn}>
      <Text weight="semibold">{onboarding.user?.name}</Text>
      <Text size={200} className={styles.hint}>
        {onboarding.providerId} · {onboarding.modelId}
      </Text>
      <Button appearance="subtle" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
