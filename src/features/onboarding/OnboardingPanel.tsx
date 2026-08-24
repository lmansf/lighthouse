"use client";

/**
 * [TEAM: onboarding] Left-rail first-run flow, driven by `useAuthStore`. First
 * run collects no identity — there is no sign-in, no registration, and no
 * licensing (the app is always unlocked). Since 0.15.0 it is ONE decision:
 *
 *   -  mode         — window vs widget interface chooser (desktop only). Reuses
 *                     `ModeChooserAuto`, which auto-advances on the web twin.
 *   1. select-model — the welcome, then pick a provider/model and paste a key
 *                     (soft, never blocking, gate when the local model isn't
 *                     installed yet). When the private model is selected but
 *                     absent, the panel offers to START the ~4.2 GB download
 *                     right away — it is fire-and-forget on the server, so it
 *                     keeps downloading in the background through the first-run
 *                     tour with no waiting at the end.
 *
 * then `completeOnboarding()` lands on "done" and the app shell takes over.
 *
 * Two screens retired with the vault (openspec: refocus-chat-attachments): the
 * one that pointed the app at a documents FOLDER, and the one that asked
 * whether new files should be searchable by DEFAULT. Files now arrive in the
 * chat that needs them, and attaching one is the whole decision — so the
 * welcome moved onto the model step and first run is a single screen.
 */

import { useEffect, useState } from "react";
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
import {
  MODEL_PROVIDERS,
  MOBILE_NO_PROVIDER_TRUTHS,
  ON_DEVICE_MODEL_COPY,
  modelProvidersFor,
} from "@/contracts";
import { apiKeyBillingNote } from "@/lib/billingNotes";
import {
  LocalModelInstallPanel,
  useLocalModel,
} from "@/features/localModel/LocalModelOption";
import { useAuthStore } from "@/stores/useAuthStore";
import { useOnDeviceModel } from "@/stores/useOnDeviceModel";
import { useRagStore } from "@/stores/useRagStore";
import { ModeChooserAuto } from "./ModeChooser";
import { rememberPlatform, type PlatformKind } from "@/shell/desktopBridge";
import { LhSelect } from "@/shell/controls";
import { BEAM_SWEEP } from "@/shell/theme";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
  },
  // The Beam signature crowning each slide: a slim ink→amber sweep band — a
  // hero moment (BEAM_SWEEP is reserved for these) that never sits behind
  // body text. providers.tsx stamps data-theme on <html>; the :global rule
  // picks the sweep variant with the theme (same pattern as chat's beacon).
  beamBand: {
    height: "4px",
    flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundImage: BEAM_SWEEP.light,
    ':global([data-theme="dark"])': { backgroundImage: BEAM_SWEEP.dark },
  },
  hint: { color: tokens.colorNeutralForeground3 },
  // Quiet progress marker ("Step n of 3") so the user knows how much is left.
  // The mode chooser is a modal overlay, not an inline slide, so it isn't
  // counted — the three inline slides read the same on web and desktop.
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
  const { status, received, total, partialBytes } = useLocalModel();
  const localNotReady = providerId === "local" && status !== "ready";
  // Percent only when the total is known — early in a download it isn't yet.
  const pct = total ? ` — ${Math.min(100, Math.floor((received / total) * 100))}%` : "";

  return (
    <>
      {localNotReady && (
        <Text size={200} className={styles.warningText}>
          {status === "downloading"
            ? `The private model is still downloading${pct}. You can continue now — it keeps downloading in the background (check on it later in Settings → AI models).`
            : partialBytes
              ? "The private model download is paused — resume it above, or continue now and finish it later in Settings → AI models."
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
  const finishMode = useAuthStore((s) => s.finishMode);
  const selectModel = useAuthStore((s) => s.selectModel);
  const completeOnboarding = useAuthStore((s) => s.completeOnboarding);
  // Managed policy (add-managed-policy): null = unrestricted; a list means
  // only those providers may be selected (the engine rejects server-side).
  const allowedProviders = useRagStore((s) => s.policy?.locks.allowedProviders ?? null);

  const [providerId, setProviderId] = useState(MODEL_PROVIDERS[0].id);
  const [modelId, setModelId] = useState(MODEL_PROVIDERS[0].models[0]);
  const [apiKey, setApiKey] = useState("");

  // §1 form factor for the platform-gated copy below. Onboarding runs before
  // anything else primes platformKind(), so fetch the settings payload once
  // here; "desktop" until it answers.
  const [platform, setPlatform] = useState<PlatformKind>("desktop");
  // add-mobile-local-inference: does this device actually have an on-device
  // backend, and which tier serves it? The store probes once on a mobile shell
  // (this component primes platformKind() below, so the probe fires as soon as
  // the form factor resolves); false/"none" on desktop and on a mobile shell
  // without a backend, keeping both byte-identical.
  const {
    available: onDeviceBackend,
    tier: onDeviceTier,
    download: onDeviceDownload,
  } = useOnDeviceModel();
  useEffect(() => {
    let alive = true;
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        rememberPlatform(d?.platform);
        if (alive && (d?.platform === "ios" || d?.platform === "android")) {
          setPlatform(d.platform);
        }
      })
      .catch(() => {
        /* older engine / web — stay "desktop" */
      });
    return () => {
      alive = false;
    };
  }, []);

  // add-mobile-local-inference: the pre-fetch default is "local", but a mobile
  // shell WITHOUT a backend has no local entry — re-point it at the roster's
  // first cloud vendor once the form factor resolves. When a backend IS reported
  // (or on desktop) local stays offered, so this never fires. A user who already
  // picked a cloud provider keeps their pick.
  useEffect(() => {
    // §42: a download-offer device KEEPS "local" (the download CTA); only a
    // below-the-bar device (no backend, no offer) re-points to cloud.
    if (platform === "desktop" || onDeviceBackend || onDeviceDownload || providerId !== "local")
      return;
    const first = modelProvidersFor(platform, onDeviceBackend, onDeviceDownload)[0];
    setProviderId(first.id);
    setModelId(first.models[0]);
  }, [platform, onDeviceBackend, onDeviceDownload, providerId]);

  const provider = MODEL_PROVIDERS.find((p) => p.id === providerId)!;

  /** Commit the model choice (shared by the Continue button and Enter-to-submit). */
  function continueFromModel() {
    if (providerId !== "local" && !apiKey) {
      // §3 mobile: "Continue without a key" — finish setup with NO provider
      // selected. Deterministic asks answer either way, and the first saved
      // key later becomes the selection (Settings → AI models runs the same
      // selectModel seam). Desktop keeps the hard key gate — its escape hatch
      // is the private model radio.
      if (platform !== "desktop") void completeOnboarding();
      return;
    }
    void selectModel(providerId, modelId, apiKey);
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

  // --- The one step: welcome + choose a model --------------------------------
  if (onboarding.step === "select-model") {
    // Private-first framing: the on-device model is the hero (first, default);
    // the cloud vendors are grouped honestly, one click away. Local vs cloud is
    // just `id === "local"` — add-mobile-local-inference: the local option is
    // offered wherever the roster carries it (desktop, or a mobile shell with a
    // reported backend). A mobile shell without a backend has no local entry, so
    // the hero radio never renders and LocalModelInstallPanel never mounts.
    const localOffered = platform === "desktop" || onDeviceBackend;
    const isLocal = localOffered && providerId === "local";
    // The private model's description line: the catalog framing on desktop
    // (tier "llama-server"), the honest per-tier copy on a mobile shell.
    const localModelLabel =
      platform === "desktop"
        ? "Private — runs on this device. No API key; nothing leaves this device. (Recommended)"
        : onDeviceTier === "gguf"
          ? ON_DEVICE_MODEL_COPY.gguf
          : ON_DEVICE_MODEL_COPY.foundation;
    const cloudProviders = modelProvidersFor(platform, onDeviceBackend).filter((p) => p.id !== "local");
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
        <span className={styles.beamBand} aria-hidden />
        <Title3>Welcome to Lighthouse</Title3>
        <ul className={styles.bullets}>
          <li>
            <Text>Attach up to 10 files to a chat and ask about them.</Text>
          </li>
          <li>
            <Text>Your files stay on this device — nothing is moved or copied out.</Text>
          </li>
          <li>
            <Text>Nothing leaves this device until you choose a cloud model.</Text>
          </li>
        </ul>
        <Text weight="semibold">Choose your model</Text>
        <Text className={styles.hint}>
          {/* §3: the mobile slide leads with the two truths — narration needs a
              cloud key, and the private model is a desktop thing. */}
          {platform === "desktop"
            ? "Private by default — your files stay on this device unless you choose a cloud model."
            : MOBILE_NO_PROVIDER_TRUTHS}
        </Text>

        {/* Hero: the on-device private model comes first. Cloud is the honest
            alternative right beneath it — no dark pattern, one click away.
            add-mobile-local-inference: shown wherever local is offered (desktop,
            or a mobile shell with a backend); a mobile shell without a backend
            has no local entry, so there is no local/cloud choice and the radio
            group is gone. */}
        {localOffered && (
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
              label={localModelLabel}
            />
            <Radio
              value="cloud"
              disabled={!cloudProviders.some((p) => isAllowed(p.id))}
              label="Cloud model — sends excerpts of the files you attach to a provider you choose, to answer."
            />
          </RadioGroup>
        )}

        {isLocal ? (
          /* onboarding copy: the panel's download button doubles as the
             "start it now, keep setting up" offer — starting NEVER blocks
             Continue (the soft gate below stays soft) because the download is
             fire-and-forget on the server and survives leaving this step.
             add-mobile-local-inference: the llama-server download panel is a
             desktop concept — a mobile backend has nothing to download (Tier-1
             is resident, Tier-2 fetches via the shell), so on a mobile shell the
             private model is simply selected with no panel beneath the radio. */
          platform === "desktop" ? (
            <LocalModelInstallPanel onboarding />
          ) : null
        ) : (
          <>
            {/* Honest cloud heading, naming the selected vendor. */}
            <Text weight="semibold">Cloud models</Text>
            <Text className={styles.hint}>
              Sends excerpts of the files you attach to {provider.label} to answer.
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
              <LhSelect
                options={provider.models.map((m) => ({ value: m, label: m }))}
                value={modelId}
                onChange={setModelId}
                aria-label="Model"
              />
            </Field>
            {/* Billing clarity (0.12.1 §4): name the vendor's products so a
                user doesn't assume a chat subscription covers API-key use. */}
            {apiKeyBillingNote(providerId) && (
              <Text className={styles.hint}>{apiKeyBillingNote(providerId)}</Text>
            )}
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
        {platform === "desktop" ? (
          <ContinueSetupButton providerId={providerId} disabled={!isLocal && !apiKey} />
        ) : (
          /* §3 mobile: never hard-block — with no key the primary action
             finishes setup with NO provider selected (continueFromModel);
             deterministic answers work from day zero. */
          <Button appearance="primary" type="submit">
            {apiKey ? "Continue" : "Continue without a key"}
          </Button>
        )}
      </form>
    );
  }

  // step === "done": app/page.tsx swaps in the working shell, so this panel
  // renders nothing.
  return null;
}
