"use client";

/**
 * [TEAM: onboarding] Left-rail first-run flow, driven by `useAuthStore`. First
 * run collects no identity — there is no sign-in, no registration, and no
 * licensing (the app is always unlocked). It walks the user through four steps:
 *
 *   1. vault        — welcome + where the user's documents live (their vault
 *                     folder); on desktop they can open it and are told they can
 *                     change it from the File menu.
 *   -  mode         — window vs widget interface chooser (desktop only). Reuses
 *                     `ModeChooserAuto`, which auto-advances on the web twin.
 *   2. select-model — pick a provider/model and paste a key (soft, never
 *                     blocking, gate when the local model isn't installed yet).
 *   3. inclusion    — whether newly-added files are searchable by default.
 *
 * then `completeOnboarding()` lands on "done" and the app shell takes over.
 */

import { useEffect, useRef, useState } from "react";
import {
  Button,
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
  LocalModelInstallPanel,
  useLocalModel,
} from "@/features/localModel/LocalModelOption";
import { useAuthStore } from "@/stores/useAuthStore";
import { useRagStore } from "@/stores/useRagStore";
import { ModeChooserAuto } from "./ModeChooser";
import { isDesktopShell } from "@/shell/desktopBridge";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  // Quiet progress marker ("Step n of 3") so the user knows how much is left.
  // The mode chooser is a modal overlay, not an inline slide, so it isn't
  // counted — the three inline slides read the same on web and desktop.
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
  warningText: { color: tokens.colorStatusWarningForeground2 },
  row: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
});

/**
 * The select-model slide's primary action, with a soft gate for the local
 * model: if the private model isn't installed yet the user can still continue
 * (onboarding must never hard-block), but the button stops over-promising
 * ("Continue anyway") and a warning explains where to get the model later.
 * Split out as a component because `useLocalModel` polls `/api/model`, and
 * mounting it only on this slide keeps the earlier slides from polling.
 */
function ContinueSetupButton({ providerId, disabled }: { providerId: string; disabled: boolean }) {
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
            ? `The private model is still downloading${pct}. You can continue now and check on it later in Settings → AI models.`
            : "The private model isn't installed yet — install it above, or continue now and add it later in Settings → AI models."}
        </Text>
      )}
      {/* type=submit so the enclosing form's onSubmit (Enter or click) continues. */}
      <Button appearance="primary" type="submit" disabled={disabled}>
        {localNotReady ? "Continue anyway" : "Continue"}
      </Button>
    </>
  );
}

export function OnboardingPanel() {
  const styles = useStyles();
  const onboarding = useAuthStore((s) => s.onboarding);
  const finishVault = useAuthStore((s) => s.finishVault);
  const finishMode = useAuthStore((s) => s.finishMode);
  const selectModel = useAuthStore((s) => s.selectModel);
  const setDefaultInclusion = useAuthStore((s) => s.setDefaultInclusion);
  const completeOnboarding = useAuthStore((s) => s.completeOnboarding);
  // Managed policy (add-managed-policy): null = unrestricted; a list means
  // only those providers may be selected (the engine rejects server-side).
  const allowedProviders = useRagStore((s) => s.policy?.locks.allowedProviders ?? null);
  const setStep = useAuthStore((s) => s.setStep);

  const [providerId, setProviderId] = useState(MODEL_PROVIDERS[0].id);
  const [modelId, setModelId] = useState(MODEL_PROVIDERS[0].models[0]);
  const [apiKey, setApiKey] = useState("");

  // Default-inclusion choice: whether newly-added files are searchable by
  // default. Pre-filled from the current effective default; the user can change
  // it. `touched` stops the background-loaded default from overwriting a choice.
  const [inclusionPref, setInclusionPref] = useState<"include" | "exclude">("include");
  const inclusionTouched = useRef(false);
  const [finishing, setFinishing] = useState(false);

  // Desktop-only affordances (opening the vault folder). Resolved after mount
  // so the __TAURI_INTERNALS__ probe can't cause an SSR/client hydration
  // mismatch (the server always renders the web branch).
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    setIsDesktop(isDesktopShell());
  }, []);

  // Sync the radio to the effective default once the profile has loaded, unless
  // the user has already picked.
  useEffect(() => {
    if (!inclusionTouched.current && onboarding.defaultInclusion) {
      setInclusionPref(onboarding.defaultInclusion);
    }
  }, [onboarding.defaultInclusion]);

  const provider = MODEL_PROVIDERS.find((p) => p.id === providerId)!;

  /** Open the vault folder in the OS file manager (desktop only; reuses the
   *  same /api/reveal seam as the explorer's "Open vault folder" button — a
   *  blank node id reveals the vault directory itself). */
  function openVaultFolder() {
    void fetch("/api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {});
  }

  /** Commit the model choice (shared by the Continue button and Enter-to-submit). */
  function continueFromModel() {
    if (providerId !== "local" && !apiKey) return;
    void selectModel(providerId, modelId, apiKey);
  }

  /** Persist the include/exclude choice and finish onboarding (→ "done"). */
  async function completeInclusion() {
    setFinishing(true);
    await setDefaultInclusion(inclusionPref).catch(() => {});
    await completeOnboarding();
    setFinishing(false);
  }

  // --- Step 1: vault (welcome + where documents live) ------------------------
  if (onboarding.step === "vault") {
    return (
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault();
          void finishVault();
        }}
      >
        <Text size={200} className={styles.stepLabel}>
          Step 1 of 3
        </Text>
        <Title3>Welcome to Lighthouse</Title3>
        <ul className={styles.bullets}>
          <li>
            <Text>Your files stay on your machine.</Text>
          </li>
          <li>
            <Text>Chat with an AI grounded in your own documents.</Text>
          </li>
          <li>
            <Text>Nothing leaves your computer until you choose a cloud model.</Text>
          </li>
        </ul>
        <Text className={styles.hint}>
          Your documents live in your Lighthouse vault folder. Add files there and
          Lighthouse can search them and answer questions grounded in what they say.
        </Text>
        {isDesktop && (
          <>
            <Button appearance="secondary" type="button" onClick={openVaultFolder}>
              Open vault folder
            </Button>
            <Text size={200} className={styles.hint}>
              You can change where your vault lives anytime from the File menu →
              &ldquo;Choose vault folder…&rdquo;.
            </Text>
          </>
        )}
        <Button appearance="primary" type="submit">
          Continue
        </Button>
      </form>
    );
  }

  // --- Mode: window vs widget (desktop only) ---------------------------------
  // ModeChooserAuto asks the question once on a fresh desktop install and calls
  // onSettled exactly once — immediately on the web twin (or when already
  // chosen), otherwise when its dialog closes. Either way we advance to the
  // model step, so the web twin never sees this step's placeholder for long.
  if (onboarding.step === "mode") {
    return (
      <div className={styles.panel}>
        <Spinner label="Setting up Lighthouse…" />
        <ModeChooserAuto onSettled={() => void finishMode()} />
      </div>
    );
  }

  // --- Step 2: select a model ------------------------------------------------
  if (onboarding.step === "select-model") {
    // Private-first framing: the on-device model is the hero (first, default);
    // the cloud vendors are grouped honestly, one click away. Local vs cloud is
    // just `id === "local"`.
    const isLocal = providerId === "local";
    const cloudProviders = MODEL_PROVIDERS.filter((p) => p.id !== "local");
    const isAllowed = (id: string) => (allowedProviders ? allowedProviders.includes(id) : true);
    const firstAllowedCloud = cloudProviders.find((p) => isAllowed(p.id)) ?? cloudProviders[0];
    const localModelId = MODEL_PROVIDERS.find((p) => p.id === "local")!.models[0];

    return (
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault();
          continueFromModel();
        }}
      >
        <Text size={200} className={styles.stepLabel}>
          Step 2 of 3
        </Text>
        <Title3>Choose your model</Title3>
        <Text className={styles.hint}>
          Private by default — your files stay on this device unless you choose a cloud model.
        </Text>

        {/* Hero: the on-device private model comes first. Cloud is the honest
            alternative right beneath it — no dark pattern, one click away. */}
        <RadioGroup
          value={isLocal ? "local" : "cloud"}
          onChange={(_, d) => {
            if (d.value === "local") {
              setProviderId("local");
              setModelId(localModelId);
            } else {
              setProviderId(firstAllowedCloud.id);
              setModelId(firstAllowedCloud.models[0]);
            }
          }}
        >
          <Radio
            value="local"
            disabled={!isAllowed("local")}
            label="Private — runs on this device. No API key; nothing leaves your computer. (Recommended)"
          />
          <Radio
            value="cloud"
            disabled={!cloudProviders.some((p) => isAllowed(p.id))}
            label="Cloud model — sends excerpts of your included files to a provider you choose, to answer."
          />
        </RadioGroup>

        {isLocal ? (
          <LocalModelInstallPanel />
        ) : (
          <>
            {/* Honest cloud heading, naming the selected vendor. */}
            <Text weight="semibold">Cloud models</Text>
            <Text className={styles.hint}>
              Sends excerpts of your included files to {provider.label} to answer.
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
                {cloudProviders.map((p) => (
                  <Option
                    key={p.id}
                    value={p.id}
                    text={p.label}
                    // Managed policy: disallowed providers render disabled (the
                    // engine rejects server-side regardless).
                    disabled={!isAllowed(p.id)}
                  >
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
                placeholder="Paste your API key"
              />
            </Field>
          </>
        )}
        <ContinueSetupButton providerId={providerId} disabled={!isLocal && !apiKey} />
        <Button appearance="subtle" type="button" onClick={() => setStep("vault")}>
          Back
        </Button>
      </form>
    );
  }

  // --- Step 3: default inclusion ---------------------------------------------
  if (onboarding.step === "inclusion") {
    return (
      <form
        className={styles.panel}
        onSubmit={(e) => {
          e.preventDefault();
          if (finishing) return;
          void completeInclusion();
        }}
      >
        <Text size={200} className={styles.stepLabel}>
          Step 3 of 3
        </Text>
        <Title3>One last choice</Title3>
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
        <Text className={styles.hint}>
          You can change this anytime; it only sets the starting point for files you add.
        </Text>
        <div className={styles.row}>
          <Button
            appearance="subtle"
            type="button"
            disabled={finishing}
            onClick={() => setStep("select-model")}
          >
            Back
          </Button>
          <Button appearance="primary" type="submit" disabled={finishing}>
            Finish setup
          </Button>
        </div>
      </form>
    );
  }

  // step === "done": app/page.tsx swaps in the working shell, so this panel
  // renders nothing.
  return null;
}
