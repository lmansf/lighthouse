"use client";

/**
 * [TEAM: onboarding] PLACEHOLDER.
 *
 * Working stub for the left-rail onboarding flow: a sign-in slide, then a
 * model-select slide where the user picks a provider/model and pastes a key,
 * with a contextual "get your key" link per provider. The onboarding team
 * expands this into the full multi-slide registration. Drive `useAuthStore`.
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
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { MODEL_PROVIDERS } from "@/contracts";
import { LocalModelOption } from "@/features/localModel/LocalModelOption";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLicenseStore } from "@/stores/useLicenseStore";
import { logEvent } from "@/lib/logEvent";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
  },
  hint: { color: tokens.colorNeutralForeground3 },
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

export function OnboardingPanel() {
  const styles = useStyles();
  const onboarding = useAuthStore((s) => s.onboarding);
  const signIn = useAuthStore((s) => s.signIn);
  const finishRegistration = useAuthStore((s) => s.finishRegistration);
  const selectModel = useAuthStore((s) => s.selectModel);
  const signOut = useAuthStore((s) => s.signOut);
  const startTrial = useLicenseStore((s) => s.startTrial);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
  // Usage logging is opt-IN: unchecked by default. The user must actively check
  // it to share analytics (which include their account email).
  const [shareUsage, setShareUsage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const emailPrefilled = useRef(false);
  const startedLogged = useRef(false);

  // The activation funnel begins when onboarding first appears.
  useEffect(() => {
    if (startedLogged.current) return;
    startedLogged.current = true;
    logEvent("onboarding_started");
  }, []);

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
          // Honored server-side AFTER the trial is minted (which resets consent
          // to the opted-out default), so the user's explicit choice here wins.
          usageLoggingOptOut: !shareUsage,
        }),
      });
      const result = await res.json().catch(() => null);
      if (result?.ok === false && result.reason === "rejected") {
        console.warn("Registration was rejected and not saved", result.detail);
      }
    } catch {
      /* network error — proceed regardless; the user can't be blocked here */
    }
    await finishRegistration();
    // play_first drops the user straight into the sample vault from here.
    if (onboarding.onboardingVariant === "play_first") logEvent("sample_vault_loaded");
    setSubmitting(false);
  }

  if (onboarding.step === "sign-in") {
    return (
      <div className={styles.panel}>
        <Title3>Welcome</Title3>
        <Text className={styles.hint}>Sign in to set up your Lighthouse.</Text>
        <Field label="Email">
          <Input value={email} onChange={(_, d) => setEmail(d.value)} type="email" />
        </Field>
        <Field label="Password">
          <Input
            value={password}
            onChange={(_, d) => setPassword(d.value)}
            type="password"
          />
        </Field>
        <Button
          appearance="primary"
          disabled={!email}
          onClick={() => void signIn(email, password)}
        >
          Continue
        </Button>
      </div>
    );
  }

  if (onboarding.step === "register") {
    return (
      <div className={styles.panel}>
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
        <Checkbox
          checked={shareUsage}
          onChange={(_, d) => setShareUsage(Boolean(d.checked))}
          label="Help improve Lighthouse by sharing usage analytics — includes your account email and which features you use, never your files, their names, or their contents"
        />
        <div className={styles.row}>
          <Button
            appearance="primary"
            disabled={submitting || !regEmail}
            onClick={() => void submitRegistration()}
          >
            Submit
          </Button>
          <Button
            appearance="subtle"
            disabled={submitting}
            onClick={() =>
              void (async () => {
                // Skipping still starts a trial (no contact info) so the user
                // isn't dropped straight onto the "trial ended" screen. The trial
                // reset sets consent to the opted-out default, so persist the
                // user's explicit choice either way (opt-in only if they checked).
                await startTrial();
                await fetch("/api/usage", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ op: "consent", optOut: !shareUsage }),
                }).catch(() => {});
                await finishRegistration();
                if (onboarding.onboardingVariant === "play_first") logEvent("sample_vault_loaded");
              })()
            }
          >
            Skip
          </Button>
        </div>
      </div>
    );
  }

  if (onboarding.step === "select-model") {
    return (
      <div className={styles.panel}>
        <Title3>Choose your model</Title3>
        <Text className={styles.hint}>
          {providerId === "local"
            ? "The local model runs entirely on your machine — no API key, nothing leaves your computer."
            : "Pick your primary model and add its API key."}
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
              <Option key={p.id} value={p.id} text={p.label}>
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
              placeholder="sk-…"
            />
          </Field>
        )}
        <Button
          appearance="primary"
          disabled={providerId !== "local" && !apiKey}
          onClick={() => {
            // Activation guardrail: did they connect a real (cloud) key?
            if (providerId !== "local" && apiKey) logEvent("api_key_entered");
            void selectModel(providerId, modelId, apiKey);
          }}
        >
          Finish setup
        </Button>
      </div>
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
