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
import { useAuthStore } from "@/stores/useAuthStore";

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
  const [submitting, setSubmitting] = useState(false);
  const emailPrefilled = useRef(false);

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
            onClick={() => void finishRegistration()}
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
          Pick your primary model and add its API key.
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
              <Option key={p.id} value={p.id}>
                {p.label}
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
        <Button
          appearance="primary"
          disabled={!apiKey}
          onClick={() => void selectModel(providerId, modelId, apiKey)}
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
