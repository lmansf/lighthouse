"use client";

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Link,
  Menu,
  MenuItem,
  MenuList,
  MenuTrigger,
  Option,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  BoardRegular,
  BookRegular,
  BrainCircuitRegular,
  DeleteRegular,
  HistoryRegular,
  InfoRegular,
  LibraryRegular,
  LightbulbRegular,
  OpenRegular,
  OptionsRegular,
  PinRegular,
  QuestionCircleRegular,
  SettingsRegular,
  ShieldTaskRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import { LhDialogSurface, LhMenuPopover, LhSegmented, LhSelect, LhSwitch } from "@/shell/controls";
import {
  MODEL_PROVIDERS,
  MOBILE_NO_PROVIDER_TRUTHS,
  ON_DEVICE_MODEL_COPY,
  modelProvidersFor,
  ragService,
  type AuditSnapshot,
  type SigninStart,
  type SigninStatus,
} from "@/contracts";
import { platformKind } from "@/shell/desktopBridge";
import { LocalModelInstallPanel, humanBytes } from "@/features/localModel/LocalModelOption";
import { apiKeyBillingNote, signinBillingNote } from "@/lib/billingNotes";
import { RULE_ACTION_LABEL } from "@/features/explorer/FolderRulesDialog";
import { SemanticNav } from "@/features/semantic/SemanticNav";
import { ViewsNav } from "@/features/views/ViewsNav";
import { START_TOUR_EVENT } from "@/features/help/FirstRunTour";
import { showWidget, summonHotkey, prettyShortcut, modKey } from "@/features/onboarding/ModeChooser";
import { useAuthStore } from "@/stores/useAuthStore";
import { useOnDeviceModel } from "@/stores/useOnDeviceModel";
import { useThemeStore } from "@/stores/useThemeStore";
import { useAppearanceStore } from "@/stores/useAppearanceStore";
import { useChatStore } from "@/stores/useChatStore";
import { useRagStore } from "@/stores/useRagStore";
import { BEAM_SWEEP } from "@/shell/theme";

export const LH_REPO = "https://github.com/lmansf/lighthouse";

const useStyles = makeStyles({
  full: { width: "100%" },
  error: { color: tokens.colorPaletteRedForeground1 },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  modelFields: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  testKeyRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  // Provider sign-in (0.12.1 §3): the device-flow pane under the OpenAI row.
  signinPane: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: tokens.spacingVerticalS,
  },
  signinRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  // The user code, LARGE and unmistakable — monospace with tabular numerals
  // so the digits the user must retype line up glyph-for-glyph.
  signinCode: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.08em",
    fontVariantNumeric: "tabular-nums",
    color: tokens.colorNeutralForeground1,
  },
  signinOk: { color: tokens.colorPaletteGreenForeground1 },
  testKeyOk: { color: tokens.colorPaletteGreenForeground1 },
  savedNote: { color: tokens.colorPaletteGreenForeground1, fontSize: tokens.fontSizeBase200 },
  // Preferences dialog: sections separated by a little vertical air.
  prefFields: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  prefHint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  // G5: the briefing-note hour picker row (label + dropdown, inline).
  prefRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  // Hydration placeholder / load-failure row for the desktop-only settings, so
  // "still loading" and "load failed" don't both look like "unsupported".
  prefLoadingRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3 },
  // Waiting-on-permission note under the whisper switch — warning tint so it
  // reads as "action needed" without the alarm of a hard error red.
  prefWarn: { color: tokens.colorStatusWarningForeground1, fontSize: tokens.fontSizeBase200 },
  // Curation rules (openspec: add-curation-rules): the Preferences list —
  // name | action | scope | remove, one compact row per rule.
  ruleList: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  ruleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXXS, tokens.spacingHorizontalS),
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  ruleName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  // An orphaned scope (folder gone — the rule matches nothing) is struck
  // through, the promised "kept for cleanup" cue.
  ruleOrphan: { textDecorationLine: "line-through" },
  // Summon-shortcut recorder: the chord chip, Change, and Reset on one line.
  shortcutRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  // The current chord as a small monospace keycap (mirrors QuickStart's kbd).
  shortcutValue: {
    ...shorthands.padding(tokens.spacingVerticalXXS, tokens.spacingHorizontalS),
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  // A menu item laid out as a row so a shortcut hint can sit at the right edge.
  menuItemRow: { display: "flex", width: "100%", alignItems: "center" },
  // Right-aligned keyboard-shortcut hint inside a menu item.
  menuShortcut: { marginLeft: "auto", paddingLeft: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  // Audit log viewer: the on/off + integrity summary sits above the table.
  auditHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    marginBottom: tokens.spacingVerticalM,
  },
  // Scroll the records inside the dialog so 200 rows never grow it unbounded.
  auditScroll: {
    maxHeight: "46vh",
    overflowY: "auto",
    overflowX: "auto",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
  },
  auditTable: { display: "flex", flexDirection: "column", minWidth: "440px" },
  // Four-column record row: Time | Provider | Files | Left machine.
  auditRow: {
    display: "grid",
    gridTemplateColumns: "1.5fr 0.9fr 0.7fr 1.4fr",
    gap: tokens.spacingHorizontalM,
    alignItems: "baseline",
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalM),
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // Sticky header row so column labels stay visible while the body scrolls.
  auditHeadRow: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  // Truncate long cell values; the full value lives in a title tooltip.
  auditCell: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase200,
  },
  // The security-relevant column: emphasize a real host that left the machine.
  auditEgressOut: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorPaletteRedForeground1 },
  // Friendly empty state when nothing has been recorded yet.
  auditEmpty: { color: tokens.colorNeutralForeground3, ...shorthands.padding(tokens.spacingVerticalL, 0) },
  // About: settings' one hero use of the Beam signature — a slim ink→amber
  // band crowning the dialog (same pattern as the onboarding/tour headers),
  // never behind body text. Theme variant via the data-theme stamp on <html>.
  aboutBand: {
    height: "3px",
    flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundImage: BEAM_SWEEP.light,
    ':global([data-theme="dark"])': { backgroundImage: BEAM_SWEEP.dark },
  },
  aboutStack: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  aboutVersion: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    letterSpacing: "0.02em",
  },
  aboutIdentity: { color: tokens.colorNeutralForeground2 },
});

/** First model of a provider id, falling back to the first known provider. */
function firstModelFor(pid: string): string {
  return (MODEL_PROVIDERS.find((p) => p.id === pid) ?? MODEL_PROVIDERS[0]).models[0];
}

/** External hand-off in the user's own browser — the feedback flow's idiom
 *  (BugReport.tsx openExternal): a plain window.open the desktop shell routes
 *  to the OS browser; Lighthouse itself transmits nothing here. */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Manage the active model provider/model and API key after onboarding. Reuses
 * the same selectModel seam as the onboarding model step; the server preserves
 * the stored key when the field is left blank, so the user can switch model
 * without re-pasting their key.
 */
export function AiModelsDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  const onboarding = useAuthStore((s) => s.onboarding);
  // switchModel = selectModel + completeOnboarding in one publish: a post-
  // onboarding save must never park the shell back on the onboarding step.
  const switchModel = useAuthStore((s) => s.switchModel);
  const validateKey = useAuthStore((s) => s.validateKey);
  // Managed policy (add-managed-policy): null = unrestricted; a list means
  // only those providers may be selected (rows render disabled — the engine
  // rejects server-side regardless).
  const allowedProviders = useRagStore((s) => s.policy?.locks.allowedProviders ?? null);

  // add-mobile-local-inference: form factor + on-device backend drive the
  // roster. On a mobile shell WITHOUT a backend the roster has no local entry,
  // so the dialog's default selection is the roster's first CLOUD vendor and the
  // local/cloud radio never renders; WITH a backend the private model leads
  // again (and is the default). platformKind() is primed from the first
  // capability payload, long before Settings can open; the store probes once.
  const platform = platformKind();
  const { available: onDeviceBackend, tier: onDeviceTier, reason: onDeviceReason } = useOnDeviceModel();
  const roster = modelProvidersFor(platform, onDeviceBackend);
  const [providerId, setProviderId] = useState(onboarding.providerId ?? roster[0].id);
  const [modelId, setModelId] = useState(onboarding.modelId ?? firstModelFor(providerId));
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  // Provider sign-in (0.12.1 §3), OpenAI row only. `signin` is the engine's
  // status — null until loaded, and available:false on every stock build, so
  // NOTHING sign-in-related renders unless a maintainer configured the flow
  // (fail-closed invisibility). Desktop-gated like other filesystem-backed
  // affordances.
  const desktop = useRagStore((s) => s.desktop);
  const [signin, setSignin] = useState<SigninStatus | null>(null);
  const [signinFlow, setSigninFlow] = useState<SigninStart | null>(null);
  const [signinError, setSigninError] = useState<string | null>(null);
  const [signinBusy, setSigninBusy] = useState(false);

  // §3 stray weights on a mobile shell (a data dir synced/copied from a
  // desktop install): the roster has no local entry, so the install panel —
  // the usual uninstall home — never mounts. Probe /api/model on open
  // (engine reports "unsupported" with the leftover byte count) and offer
  // the one honest affordance: remove the file, free the space. Desktop
  // never probes here — its panel owns the uninstall flow.
  const [strayBytes, setStrayBytes] = useState(0);
  useEffect(() => {
    if (!open || platform === "desktop") return;
    let alive = true;
    void fetch("/api/model")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setStrayBytes(d?.status === "unsupported" && d.removable ? d.total || 0 : 0);
      })
      .catch(() => {
        /* transient — the row just doesn't show this open */
      });
    return () => {
      alive = false;
    };
  }, [open, platform]);

  async function removeStray() {
    try {
      // The existing uninstall seam; on mobile the engine deletes directly
      // (no marker handshake) and reports the post-delete state.
      const r = await fetch("/api/model", { method: "DELETE" });
      if (r.ok) {
        const d = await r.json();
        setStrayBytes(d?.removable ? d.total || 0 : 0);
      }
    } catch {
      /* keep the row — the user can retry */
    }
  }

  // Re-sync the fields to the saved settings on the open transition.
  useEffect(() => {
    if (!open) return;
    const current = useAuthStore.getState().onboarding;
    // add-mobile-local-inference: same availability-aware default as the initial
    // state — "local" only when the roster offers it (desktop, or a mobile shell
    // with a reported backend); otherwise the first cloud vendor.
    const pid = current.providerId ?? modelProvidersFor(platformKind(), onDeviceBackend)[0].id;
    setProviderId(pid);
    setModelId(current.modelId ?? firstModelFor(pid));
    setApiKey("");
    setError(null);
    setTestResult(null);
    setSigninFlow(null);
    setSigninError(null);
  }, [open, onDeviceBackend]);

  // Load the sign-in status when the OpenAI row is in view; any provider
  // switch abandons an in-flight code (the engine's pending handshake simply
  // expires — nothing was granted).
  useEffect(() => {
    setSigninFlow(null);
    setSigninError(null);
    if (!open || providerId !== "openai") {
      setSignin(null);
      return;
    }
    let alive = true;
    ragService
      .providerAuthStatus()
      .then((s) => {
        if (alive) setSignin(s);
      })
      .catch(() => {
        if (alive) setSignin(null); // unknown ⇒ render nothing (fail closed)
      });
    return () => {
      alive = false;
    };
  }, [open, providerId]);

  // Live poll while a sign-in code is on screen, at the vendor's interval
  // (chained timeouts so a slow_down bump takes effect on the next tick).
  useEffect(() => {
    if (!open || !signinFlow) return;
    let alive = true;
    let timer: number | undefined;
    let interval = Math.max(signinFlow.intervalMs, 500);
    const tick = async () => {
      try {
        const p = await ragService.providerAuthPoll();
        if (!alive) return;
        if (p.error) {
          setSigninError(p.error); // expired/declined — reset with the reason
          setSigninFlow(null);
          return;
        }
        if (p.status === "complete") {
          const s = await ragService.providerAuthStatus();
          if (!alive) return;
          setSigninFlow(null);
          setSignin(s);
          return;
        }
        if (typeof p.intervalMs === "number" && p.intervalMs > 0) interval = p.intervalMs;
      } catch {
        // Transient transport hiccup — keep polling at the same cadence.
      }
      timer = window.setTimeout(() => void tick(), interval);
    };
    timer = window.setTimeout(() => void tick(), interval);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, signinFlow]);

  const provider = MODEL_PROVIDERS.find((p) => p.id === providerId) ?? MODEL_PROVIDERS[0];
  // Per-provider "a key is on file" — falls back to the legacy flag for the
  // saved provider when an older engine doesn't report keyedProviders yet.
  const providerHasSavedKey =
    onboarding.keyedProviders?.includes(providerId) ??
    (providerId === onboarding.providerId && onboarding.hasApiKey);

  // Private-first framing (matches onboarding): the on-device model is the hero;
  // cloud vendors are the honest, one-click alternative grouped below. Local vs
  // cloud is just `id === "local"` — add-mobile-local-inference: the local
  // option is offered when the roster carries it (desktop, or a mobile shell
  // with a reported on-device backend); mobile-without-a-backend still has no
  // local entry, so it never renders the radio (and never mounts the desktop
  // install panel below, which stays `platform === "desktop"`-gated).
  const localOffered = platform === "desktop" || onDeviceBackend;
  const isLocal = localOffered && providerId === "local";
  // The private model's description line: the catalog label on desktop
  // (tier "llama-server"), the honest per-tier copy on a mobile shell.
  const localModelLabel =
    platform === "desktop"
      ? "Private — runs on this device. No API key; nothing leaves this device. (Recommended)"
      : onDeviceTier === "gguf"
        ? ON_DEVICE_MODEL_COPY.gguf
        : ON_DEVICE_MODEL_COPY.foundation;
  const cloudProviders = roster.filter((p) => p.id !== "local");
  const isAllowed = (id: string) => (allowedProviders ? allowedProviders.includes(id) : true);
  const firstAllowedCloud = cloudProviders.find((p) => isAllowed(p.id)) ?? cloudProviders[0];
  const localModelId = MODEL_PROVIDERS.find((p) => p.id === "local")!.models[0];

  // Sign-in only surfaces when the engine says the flow is CONFIGURED
  // (available) — plus the one recovery case: a persisted "signin" choice on
  // a build where the flow has since become unavailable still shows the
  // control (with the honest reason instead of a button) so the user can
  // switch back to the key without editing files by hand. A stock build has
  // method "key" and available false ⇒ nothing renders.
  const signinControl =
    providerId === "openai" &&
    desktop &&
    signin !== null &&
    (signin.available || signin.method === "signin");
  const signinPane = signinControl && signin.method === "signin";

  function updateAuthMethod(next: "key" | "signin") {
    if (!signin || signin.method === next) return;
    const prev = signin.method;
    setSignin({ ...signin, method: next });
    setSigninError(null);
    setSigninFlow(null);
    void ragService
      .providerAuthSetMethod(next)
      .then((r) => {
        if (!r.ok) {
          // Rolled back — the control never lies about a choice that didn't
          // persist (the Preferences postSetting idiom).
          setSignin((s) => (s ? { ...s, method: prev } : s));
          setSigninError(r.error ?? "That change couldn't be saved — try again.");
        }
      })
      .catch(() => {
        setSignin((s) => (s ? { ...s, method: prev } : s));
        setSigninError("That change couldn't be saved — try again.");
      });
  }

  async function startSignin() {
    setSigninBusy(true);
    setSigninError(null);
    try {
      const res = await ragService.providerAuthStart();
      if (res.start) setSigninFlow(res.start);
      else setSigninError(res.error ?? "couldn't start sign-in");
    } catch {
      setSigninError("couldn't start sign-in — try again");
    } finally {
      setSigninBusy(false);
    }
  }

  async function signOutProvider() {
    setSigninBusy(true);
    setSigninError(null);
    try {
      await ragService.providerAuthSignout();
      setSignin(await ragService.providerAuthStatus());
    } catch {
      setSigninError("couldn't sign out — try again");
    } finally {
      setSigninBusy(false);
    }
  }

  async function testKey() {
    setTesting(true);
    setTestResult(null);
    try {
      // Empty field ⇒ the engine tests the key it would actually chat with.
      setTestResult(await validateKey(providerId, apiKey));
    } catch {
      setTestResult({ ok: false, error: "couldn't reach the engine — try again" });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Empty key ⇒ keep the existing one (selectModel falls back to the stored key).
      await switchModel(providerId, modelId, apiKey);
      setOpen(false); // close immediately on success — the close IS the confirmation
    } catch {
      setError("Couldn't save your model settings. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>AI models</DialogTitle>
          <DialogContent>
            <div className={styles.modelFields}>
              {/* Private-first: the on-device model is the hero; cloud vendors
                  are the honest, one-click alternative grouped below.
                  add-mobile-local-inference: the radio shows wherever local is
                  offered (desktop, or a mobile shell with a backend); a mobile
                  shell WITHOUT a backend has no local entry, so there is no
                  local/cloud choice and the dialog leads with the two truths. */}
              {localOffered ? (
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
                    // Keys are per-provider: never carry a half-typed key (or a
                    // stale test verdict) across a switch.
                    setApiKey("");
                    setTestResult(null);
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
                    label="Cloud model — sends excerpts of your included files to a provider you choose, to answer."
                  />
                </RadioGroup>
              ) : (
                <>
                  {!onboarding.providerId && (
                    <Text className={styles.prefHint}>{MOBILE_NO_PROVIDER_TRUTHS}</Text>
                  )}
                  {onDeviceReason && (
                    // iOS field report (0.13.8): when this device COULD carry the
                    // on-device private model but the backend reports unavailable,
                    // say the shell's honest reason ("Apple Intelligence is not
                    // enabled…", "still preparing…") instead of silently hiding
                    // the option — the store re-probes when the user returns from
                    // the Settings app, so fixing it lights the provider up live.
                    <Text className={styles.prefHint}>
                      Private model on this device: {onDeviceReason}.
                    </Text>
                  )}
                  {strayBytes > 0 && (
                    <div className={styles.testKeyRow}>
                      <Text className={styles.prefHint}>
                        A leftover private-model file is on this device — it can&apos;t run here.
                      </Text>
                      <Button size="small" appearance="secondary" onClick={() => void removeStray()}>
                        Remove — frees {humanBytes(strayBytes)}
                      </Button>
                    </div>
                  )}
                </>
              )}
              {allowedProviders && (
                <Text className={styles.prefHint}>
                  Provider choice is managed by your organization.
                </Text>
              )}

              {isLocal ? (
                // add-mobile-local-inference: the llama-server download/uninstall
                // panel is a desktop concept (no download CTA on a mobile
                // backend — Tier-1 is resident, Tier-2 fetches via the shell).
                // On a mobile shell the private model is simply selected; there
                // is nothing to install, so no panel renders beneath the radio.
                platform === "desktop" ? (
                  <LocalModelInstallPanel />
                ) : null
              ) : (
                <>
                  {/* Honest cloud heading, naming the selected vendor. */}
                  <Text weight="semibold">Cloud models</Text>
                  <Text className={styles.prefHint}>
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
                        // Keys are per-provider: never carry a half-typed key (or
                        // a stale test verdict) from one vendor to another.
                        setApiKey("");
                        setTestResult(null);
                      }}
                    >
                      {cloudProviders.map((p) => (
                        <Option key={p.id} value={p.id} text={p.label} disabled={!isAllowed(p.id)}>
                          {p.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="Model">
                    <LhSelect
                      options={provider.models.map((m) => ({ value: m, label: m }))}
                      value={modelId}
                      onChange={(v) => {
                        setModelId(v);
                      }}
                      aria-label="Model"
                    />
                  </Field>
                  {/* Provider sign-in (0.12.1 §3), OpenAI only: renders ONLY
                      when the engine reports the registration-gated flow as
                      configured (stock builds: never — fail-closed
                      invisibility, the code-signing pattern). */}
                  {signinControl && (
                    <Field label="Connect with">
                      <LhSegmented
                        options={[
                          { value: "key", label: "Use API key" },
                          { value: "signin", label: "Sign in" },
                        ]}
                        value={signin.method}
                        onChange={(v) => updateAuthMethod(v === "signin" ? "signin" : "key")}
                        aria-label="Connect with"
                      />
                    </Field>
                  )}
                  {signinPane && (
                    <div className={styles.signinPane}>
                      {signin.signedIn ? (
                        <>
                          <Text className={styles.signinOk}>
                            ✓ Signed in
                            {signin.accountHint ? ` as ${signin.accountHint}` : ""}
                          </Text>
                          {/* Billing clarity (0.12.1 §4): signed-in usage draws
                              on the vendor account/subscription, not per-key
                              developer billing. */}
                          {signinBillingNote(providerId) && (
                            <Text className={styles.prefHint}>{signinBillingNote(providerId)}</Text>
                          )}
                          <Button
                            size="small"
                            appearance="secondary"
                            disabled={signinBusy}
                            onClick={() => void signOutProvider()}
                          >
                            Sign out
                          </Button>
                        </>
                      ) : !signin.available ? (
                        <Text className={styles.prefHint}>
                          {signin.reason ?? "sign-in isn't configured in this build"} — switch
                          back to “Use API key” above.
                        </Text>
                      ) : signinFlow ? (
                        <>
                          <Text className={styles.prefHint}>
                            Enter this code in your browser to approve the sign-in:
                          </Text>
                          <Text className={styles.signinCode} data-testid="signin-user-code">
                            {signinFlow.userCode}
                          </Text>
                          <div className={styles.signinRow}>
                            <Button
                              appearance="primary"
                              onClick={() => openExternal(signinFlow.verificationUri)}
                            >
                              Open browser
                            </Button>
                            <Spinner size="tiny" />
                            <Text size={200} className={styles.prefHint}>
                              Waiting for approval…
                            </Text>
                          </div>
                        </>
                      ) : (
                        <Button
                          appearance="primary"
                          disabled={signinBusy}
                          icon={signinBusy ? <Spinner size="tiny" /> : undefined}
                          onClick={() => void startSignin()}
                        >
                          Sign in
                        </Button>
                      )}
                      {signinError && <Text className={styles.error}>{signinError}</Text>}
                    </div>
                  )}
                  {/* The key field steps aside only while the sign-in pane
                      owns the row; method "key" (the default everywhere the
                      flow isn't configured) leaves it exactly as it was. */}
                  {!signinPane && (
                    <>
                      <Field
                        label="API key"
                        hint={
                          <Link href={provider.apiKeyUrl} target="_blank" rel="noreferrer">
                            Get your {provider.label} key →
                          </Link>
                        }
                      >
                        <Input
                          type="password"
                          value={apiKey}
                          onChange={(_, d) => {
                            setApiKey(d.value);
                            setTestResult(null);
                          }}
                          placeholder={
                            providerHasSavedKey
                              ? "•••••••• saved — leave blank to keep"
                              : "Paste your API key"
                          }
                        />
                      </Field>
                      {/* Billing clarity (0.12.1 §4): a chat subscription does
                          not cover API-key usage — name the vendor's products so
                          the distinction is unmissable. */}
                      {apiKeyBillingNote(providerId) && (
                        <Text className={styles.prefHint}>{apiKeyBillingNote(providerId)}</Text>
                      )}
                      {(apiKey || providerHasSavedKey) && (
                        <div className={styles.testKeyRow}>
                          <Button
                            size="small"
                            appearance="secondary"
                            disabled={testing}
                            icon={testing ? <Spinner size="tiny" /> : undefined}
                            onClick={() => void testKey()}
                          >
                            {testing ? "Testing…" : apiKey ? "Test key" : "Test saved key"}
                          </Button>
                          {testResult &&
                            (testResult.ok ? (
                              <Text size={200} className={styles.testKeyOk}>
                                ✓ Key works
                              </Text>
                            ) : (
                              <Text size={200} className={styles.error}>
                                ✗ {testResult.error ?? "the key didn't work"}
                              </Text>
                            ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {error && <Text className={styles.error}>{error}</Text>}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={saving}
              icon={saving ? <Spinner size="tiny" /> : undefined}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}

/**
 * Local audit-log viewer (openspec: add-audit-log). Reads the recent records +
 * enabled/intact verdict via ragService.audit on open, renders them as a compact
 * table, and can verify the chain and export a CSV into the vault. Everything it
 * shows is on-device — the log is never uploaded. The verbatim `question` is
 * usually absent (opt-in), so this only ever shows the metadata, never the sha256
 * dressed up as the question.
 */
export function AuditLogDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Transient inline result of an Export CSV — the saved file's name or an error.
  const [exportNote, setExportNote] = useState<{ name?: string; error?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Load the recent records on the open transition (mirrors AiModelsDialog's
  // reset-on-open idiom). `alive` guards against a resolve after close/reopen.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setExportNote(null);
    setSnapshot(null);
    ragService
      .audit(200)
      .then((snap) => {
        if (alive) setSnapshot(snap);
      })
      .catch(() => {
        if (alive) setError("Couldn't load the audit log. Try again.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  async function exportCsv() {
    setExporting(true);
    setExportNote(null);
    try {
      const res = await ragService.auditExport();
      if (res.error || !res.savedId) {
        setExportNote({ error: res.error ?? "Couldn't export the audit log." });
      } else {
        setExportNote({ name: res.savedName });
      }
    } catch {
      setExportNote({ error: "Couldn't export the audit log. Try again." });
    } finally {
      setExporting(false);
    }
  }

  // Explicit chain check — fold its verdict into the badge without reloading.
  async function verify() {
    setVerifying(true);
    try {
      const verdict = await ragService.auditVerify();
      setSnapshot((s) => (s ? { ...s, intact: verdict.intact } : s));
    } catch {
      // Leave the badge as-is if the check can't run.
    } finally {
      setVerifying(false);
    }
  }

  const records = snapshot?.records ?? [];
  const enabled = snapshot?.enabled ?? false;
  const intact = snapshot?.intact ?? true;
  const hasRecords = records.length > 0;

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>Audit log</DialogTitle>
          <DialogContent>
            {loading && (
              <div className={styles.prefLoadingRow}>
                <Spinner size="tiny" />
                <Text size={200} className={styles.prefHint}>
                  Loading the audit log…
                </Text>
              </div>
            )}
            {!loading && error && <Text className={styles.error}>{error}</Text>}
            {!loading && !error && snapshot && (
              <>
                <div className={styles.auditHeader}>
                  <Text size={200} className={styles.muted}>
                    Logging is {enabled ? "on" : "off"}
                  </Text>
                  {intact ? (
                    <Badge appearance="tint" color="success" icon={<ShieldTaskRegular />}>
                      Chain verified
                    </Badge>
                  ) : (
                    <Badge appearance="tint" color="danger" icon={<WarningRegular />}>
                      Tampering detected
                    </Badge>
                  )}
                </div>
                {!intact && (
                  <Text className={styles.error}>
                    Tampering detected — the log was edited or truncated.
                  </Text>
                )}
                {!hasRecords ? (
                  <Text className={styles.auditEmpty}>
                    {enabled
                      ? "No questions have been recorded yet."
                      : "The audit log is off. Turn on “Keep a local audit log” in Preferences to start recording."}
                  </Text>
                ) : (
                  <div className={styles.auditScroll}>
                    <div className={styles.auditTable} role="table" aria-label="Audit log records">
                      <div
                        className={mergeClasses(styles.auditRow, styles.auditHeadRow)}
                        role="row"
                      >
                        <span role="columnheader">Time</span>
                        <span role="columnheader">Provider</span>
                        <span role="columnheader">Files</span>
                        <span role="columnheader">Left machine</span>
                      </div>
                      {records.map((r, i) => {
                        const local = r.egress.length === 1 && r.egress[0] === "none";
                        const fileCount = `${r.fileIds.length} file${r.fileIds.length === 1 ? "" : "s"}`;
                        const hosts = r.egress.join(", ");
                        return (
                          <div key={`${r.ts}-${i}`} className={styles.auditRow} role="row">
                            <span className={styles.auditCell} role="cell">
                              {new Date(r.ts).toLocaleString()}
                            </span>
                            <span className={styles.auditCell} role="cell">
                              {r.provider}
                            </span>
                            <span
                              className={styles.auditCell}
                              role="cell"
                              title={r.fileIds.length ? r.fileIds.join(", ") : undefined}
                            >
                              {fileCount}
                            </span>
                            {local ? (
                              <span className={styles.auditCell} role="cell">
                                None (local)
                              </span>
                            ) : (
                              <span
                                className={mergeClasses(styles.auditCell, styles.auditEgressOut)}
                                role="cell"
                                title={hosts}
                              >
                                {hosts}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {exportNote?.name && (
                  <Text className={styles.savedNote}>Saved {exportNote.name} to your vault.</Text>
                )}
                {exportNote?.error && <Text className={styles.error}>{exportNote.error}</Text>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
            {hasRecords && (
              <Button
                appearance="secondary"
                disabled={verifying}
                icon={verifying ? <Spinner size="tiny" /> : undefined}
                onClick={() => void verify()}
              >
                {verifying ? "Verifying…" : "Verify integrity"}
              </Button>
            )}
            <Button
              appearance="primary"
              disabled={exporting || !hasRecords}
              icon={exporting ? <Spinner size="tiny" /> : undefined}
              onClick={() => void exportCsv()}
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}

/**
 * Map a keydown's main (non-modifier) key to a tauri accelerator token, or null
 * when the event carries only modifiers (so the recorder keeps listening).
 * Letters → `Key<Upper>`, digits → `Digit<n>`, space → "Space", named keys pass
 * through (ArrowUp, Enter, F5…), and we fall back to `code` when it already
 * looks like an accelerator token.
 */
function mainKeyToken(e: KeyboardEvent): string | null {
  const k = e.key;
  if (!k || k === "Control" || k === "Shift" || k === "Alt" || k === "Meta" || k === "OS") {
    return null;
  }
  if (k === " " || k === "Space" || k === "Spacebar") return "Space";
  if (/^[a-z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  if (/^[A-Z][A-Za-z0-9]*$/.test(k)) return k;
  if (/^(Key[A-Z]|Digit[0-9]|Numpad[A-Za-z0-9]+|F\d{1,2}|Arrow(Up|Down|Left|Right))$/.test(e.code)) {
    return e.code;
  }
  return null;
}

/**
 * Build a tauri global-hotkey accelerator from a keydown: modifiers in a fixed
 * order (control→"ctrl", meta→"super", alt→"alt", shift→"shift") joined by "+"
 * with one non-modifier key appended. Null unless at least one modifier AND a
 * main key are present — a bare key can't be a global shortcut.
 */
function accelFromEvent(e: KeyboardEvent): string | null {
  const key = mainKeyToken(e);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.metaKey) mods.push("super");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (mods.length === 0) return null;
  return [...mods, key].join("+");
}

/**
 * General preferences — the home for user-controllable settings that aren't the
 * model choice. Today: appearance (light/dark/system), whether newly-added
 * files are searchable by default (also asked once during onboarding), sharing
 * usage analytics, and (desktop only) launching Lighthouse at login. Each
 * change applies immediately.
 */
export function PreferencesDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  const defaultInclusion = useAuthStore((s) => s.onboarding.defaultInclusion);
  const setDefaultInclusion = useAuthStore((s) => s.setDefaultInclusion);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  // Appearance customization (openspec §3): accent + density + font scale, all
  // applied live through the theme (AA-validated) — no save step, like the mode.
  const accent = useAppearanceStore((s) => s.accent);
  const density = useAppearanceStore((s) => s.density);
  const fontScale = useAppearanceStore((s) => s.fontScale);
  const setAppearance = useAppearanceStore((s) => s.set);
  // Chat-history persistence is a client-side, per-device choice (localStorage,
  // not a server setting) — it lives in the chat store, off by default.
  const saveChats = useChatStore((s) => s.persistEnabled);
  const setSaveChats = useChatStore((s) => s.setPersistEnabled);
  // Managed policy (add-managed-policy): the engine enforces every lock
  // server-side; these render the affected controls disabled with the
  // "Managed by your organization" indication.
  const policy = useRagStore((s) => s.policy);
  const locks = policy?.locks;
  // Curation rules (openspec: add-curation-rules): the complete rule list,
  // scope-named and removable; orphaned scopes render struck-through.
  const rules = useRagStore((s) => s.rules);
  const loadRules = useRagStore((s) => s.loadRules);
  const removeRule = useRagStore((s) => s.removeRule);

  const [desktop, setDesktop] = useState(false);
  const [runOnStartup, setRunOnStartup] = useState(true);
  // B2 hybrid search: on-device embeddings fused into retrieval. Default on.
  const [semanticSearch, setSemanticSearch] = useState(true);
  // Background-conserve: release the local model servers (their RAM/CPU) while
  // the app sits in the tray or unfocused, bringing them back on return.
  // Default on. Window mode only — widget mode keeps the model warm.
  const [backgroundConserve, setBackgroundConserve] = useState(true);
  // OCR: read text in images and scanned PDFs with the bundled models. Default on.
  const [ocrEnabled, setOcrEnabled] = useState(true);
  // G2 draft-then-verify: show an instant extractive draft while the private
  // model composes the verified answer, replaced in place. Default on.
  const [draftAnswers, setDraftAnswers] = useState(true);
  // G5 briefing note: notify when the scheduled note refreshes (default on),
  // and the local hour it may refresh at (default 9am).
  const [briefingNotify, setBriefingNotify] = useState(true);
  const [briefingNoteHour, setBriefingNoteHour] = useState(9);
  // Local audit log (openspec: add-audit-log): record what was read / which
  // provider answered / what left the machine, per question. Default OFF.
  const [auditEnabled, setAuditEnabled] = useState(false);
  const [uiMode, setUiMode] = useState<"window" | "widget">("window");
  const [whisperMode, setWhisperMode] = useState(false);
  // macOS Accessibility state for whisper: "pending" = the system prompt is up
  // and we're waiting for the grant; else granted/unsupported/unknown. Only
  // surfaced as a note while whisper is on and still pending.
  const [whisperPermission, setWhisperPermission] = useState<string>("unknown");
  // The live summon accelerator (tauri syntax) and the inline recorder's state.
  const [summonShortcut, setSummonShortcut] = useState("ctrl+super+shift+space");
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  // False when the shell couldn't register the global shortcut (Wayland) —
  // the hint then points at the tray instead of promising a dead hotkey.
  const [hotkeyOk, setHotkeyOk] = useState(true);
  // Settings hydration state: distinguishes "still loading" from "loaded, not a
  // desktop build" from "load failed" — so the desktop options don't silently
  // vanish (indistinguishable from unsupported) on a transient error.
  const [settingsLoad, setSettingsLoad] = useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  // Surfaced when an optimistic settings write fails and is rolled back, so a
  // control never lies about a change that didn't actually persist.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Whisper's low-level hook exists on Windows (keyboard hook) and macOS
  // (Accessibility); hide the switch elsewhere rather than offering a toggle
  // that can't work. (widget-scope §3 + W3/W4.)
  const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  const isMac =
    typeof navigator !== "undefined" && navigator.userAgent.includes("Mac") && !isWindows;
  // Whisper has a backend on all three desktops (Windows hook, macOS monitor,
  // Linux/X11 raw input) — the shell reports "unsupported" ONLY on Wayland,
  // where no global input is available. So capability is "desktop and not
  // explicitly unsupported", which correctly includes X11 Linux (previously
  // the switch was hidden on all of Linux, stranding the X11 backend).
  const whisperCapable = whisperPermission !== "unsupported";
  // The modifier tap-chord, spelled per platform (whisper is modifier-only).
  const whisperChord = isMac ? "Control + ⌘ + Shift" : "Ctrl + Win + Shift";

  // Refresh the curation-rule list whenever the dialog opens (rules are also
  // created from the explorer's folder menus, so the list can be stale).
  useEffect(() => {
    if (open) void loadRules();
  }, [open, loadRules]);

  // Load the file-backed prefs (usage consent, launch-at-login, …) when opened
  // or when Retry bumps reloadKey. The settings fetch drives settingsLoad so a
  // failure shows a retry note instead of quietly hiding the desktop options.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSettingsLoad("loading");
    setSaveError(null);
    void fetch("/api/settings")
      .then((r) => {
        if (!r.ok) throw new Error(`settings ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!alive) return;
        setDesktop(Boolean(d.desktop));
        setRunOnStartup(d.runOnStartup !== false);
        setSemanticSearch(d.semanticSearch !== false);
        setBackgroundConserve(d.backgroundConserve !== false);
        setOcrEnabled(d.ocrEnabled !== false);
        setDraftAnswers(d.draftAnswers !== false);
        setBriefingNotify(d.briefingNotify !== false);
        setBriefingNoteHour(typeof d.briefingNoteHour === "number" ? d.briefingNoteHour : 9);
        setAuditEnabled(d.auditEnabled === true);
        setUiMode(d.uiMode === "widget" ? "widget" : "window");
        setWhisperMode(d.whisperMode === true);
        setWhisperPermission(typeof d.whisperPermission === "string" ? d.whisperPermission : "unknown");
        setSummonShortcut(
          typeof d.summonShortcut === "string" && d.summonShortcut
            ? d.summonShortcut
            : "ctrl+super+shift+space",
        );
        setHotkeyOk(d.summonHotkeyOk !== false);
        setSettingsLoad("ready");
      })
      .catch(() => {
        if (alive) setSettingsLoad("error");
      });
    return () => {
      alive = false;
    };
  }, [open, reloadKey]);

  const inclusion = defaultInclusion ?? "include";

  const SAVE_FAILED = "That change couldn't be saved — check your connection and try again.";

  /** POST a settings patch, rolling the optimistic UI back (and noting it) on
   *  failure so a control never shows a change that didn't actually persist.
   *  Resolves to the Response on success, or null on failure. */
  async function postSetting(
    body: Record<string, unknown>,
    revert: () => void,
  ): Promise<Response | null> {
    setSaveError(null);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`settings ${r.status}`);
      return r;
    } catch {
      revert();
      setSaveError(SAVE_FAILED);
      return null;
    }
  }


  function updateStartup(next: boolean) {
    const prev = runOnStartup;
    setRunOnStartup(next);
    // Flipping this IS startup consent — record startupAsked so the shell's
    // consent-first boot gate honors the choice (and the deferred startup
    // prompt stays quiet).
    void postSetting({ runOnStartup: next, startupAsked: true }, () => setRunOnStartup(prev));
  }

  function updateSemantic(next: boolean) {
    const prev = semanticSearch;
    setSemanticSearch(next);
    void postSetting({ semanticSearch: next }, () => setSemanticSearch(prev));
  }

  function updateConserve(next: boolean) {
    const prev = backgroundConserve;
    setBackgroundConserve(next);
    void postSetting({ backgroundConserve: next }, () => setBackgroundConserve(prev));
  }

  function updateOcr(next: boolean) {
    const prev = ocrEnabled;
    setOcrEnabled(next);
    void postSetting({ ocrEnabled: next }, () => setOcrEnabled(prev));
  }

  function updateDraftAnswers(next: boolean) {
    const prev = draftAnswers;
    setDraftAnswers(next);
    void postSetting({ draftAnswers: next }, () => setDraftAnswers(prev));
  }

  function updateBriefingNotify(next: boolean) {
    const prev = briefingNotify;
    setBriefingNotify(next);
    void postSetting({ briefingNotify: next }, () => setBriefingNotify(prev));
  }

  function updateBriefingHour(next: number) {
    const prev = briefingNoteHour;
    setBriefingNoteHour(next);
    void postSetting({ briefingNoteHour: next }, () => setBriefingNoteHour(prev));
  }

  function updateAudit(next: boolean) {
    const prev = auditEnabled;
    setAuditEnabled(next);
    void postSetting({ auditEnabled: next }, () => setAuditEnabled(prev));
  }

  function updateUiMode(next: "window" | "widget") {
    const prev = uiMode;
    setUiMode(next);
    void postSetting({ uiMode: next }, () => setUiMode(prev)).then((r) => {
      // Make the switch tangible right away instead of "at next launch" — but
      // only once the write actually stuck.
      if (r && next === "widget") void showWidget();
    });
  }

  function updateWhisper(next: boolean) {
    const prev = whisperMode;
    setWhisperMode(next);
    setSaveError(null);
    // The shell starts/stops the keyboard hook live — no relaunch needed. On
    // macOS enabling may go "pending" while Accessibility is granted; re-read
    // the state (and poll briefly) so the waiting-for-permission note appears
    // in this same session instead of only after reopening Preferences.
    void fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ whisperMode: next }),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d) => {
        if (d && typeof d.whisperPermission === "string") setWhisperPermission(d.whisperPermission);
      })
      .catch(() => {
        setWhisperMode(prev);
        setSaveError(SAVE_FAILED);
      });
    if (next) {
      // Accessibility can flip to granted a few seconds later — refresh the
      // note without needing the user to reopen the dialog. Bounded polls.
      let n = 0;
      const poll = window.setInterval(() => {
        n += 1;
        void fetch("/api/settings")
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && typeof d.whisperPermission === "string") setWhisperPermission(d.whisperPermission);
            if ((d && d.whisperPermission === "granted") || n >= 6) window.clearInterval(poll);
          })
          .catch(() => window.clearInterval(poll));
      }, 3000);
    }
  }

  // Send a new (or "" to reset) accelerator. The shell VALIDATES: on ok it
  // echoes the registered chord; on ok:false it keeps the old value and returns
  // a reason — so we never assume the change stuck.
  async function saveShortcut(next: string) {
    setShortcutError(null);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summonShortcut: next }),
      });
      const d = r.ok ? await r.json() : null;
      if (d && d.ok === true) {
        setSummonShortcut(typeof d.summonShortcut === "string" ? d.summonShortcut : next);
      } else {
        setShortcutError(
          (d && typeof d.reason === "string" && d.reason) ||
            "That shortcut couldn't be registered — try another combination.",
        );
        // The server echoes the unchanged current chord; reflect it verbatim.
        if (d && typeof d.summonShortcut === "string") setSummonShortcut(d.summonShortcut);
      }
    } catch {
      setShortcutError("Couldn't save the shortcut. Try again.");
    }
  }

  function resetShortcut() {
    setRecording(false);
    // "" resets to the default; the shell echoes the default back on success.
    void saveShortcut("");
  }

  function onRecordKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(false);
      return;
    }
    const accel = accelFromEvent(e.nativeEvent);
    if (!accel) return; // only modifiers (or no modifier) so far — keep listening
    setRecording(false);
    void saveShortcut(accel);
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>Preferences</DialogTitle>
          <DialogContent>
            <div className={styles.prefFields}>
              {policy?.error && (
                <Text className={styles.prefWarn}>
                  Managed configuration error — some settings are locked to safe
                  defaults. Contact your administrator.
                </Text>
              )}
              {policy?.present && !policy.error && (
                <Text className={styles.prefHint}>
                  Some settings are managed by your organization.
                </Text>
              )}
              {/* First: appearance is the most-reached-for preference. Applies
                  instantly via the theme store — no save step. */}
              <Field label="Appearance">
                <LhSegmented
                  options={[
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                    { value: "system", label: "Match system" },
                  ]}
                  value={themeMode}
                  onChange={(v) => setThemeMode(v === "light" || v === "dark" ? v : "system")}
                  aria-label="Appearance"
                />
              </Field>

              {/* Accent, density, font scale (openspec §3): each applies live via
                  the theme; accents are AA-validated on both themes. */}
              <Field label="Accent">
                <LhSegmented
                  options={[
                    { value: "amber", label: "Amber" },
                    { value: "teal", label: "Teal" },
                    { value: "orchid", label: "Orchid" },
                  ]}
                  value={accent}
                  onChange={(v) => setAppearance({ accent: v as typeof accent })}
                  aria-label="Accent"
                />
              </Field>
              <Field label="Density">
                <LhSegmented
                  options={[
                    { value: "comfortable", label: "Comfortable" },
                    { value: "compact", label: "Compact" },
                  ]}
                  value={density}
                  onChange={(v) => setAppearance({ density: v as typeof density })}
                  aria-label="Density"
                />
              </Field>
              <Field label="Text size">
                <LhSegmented
                  options={[
                    { value: "s", label: "Small" },
                    { value: "m", label: "Medium" },
                    { value: "l", label: "Large" },
                  ]}
                  value={fontScale}
                  onChange={(v) => setAppearance({ fontScale: v as typeof fontScale })}
                  aria-label="Text size"
                />
              </Field>

              <Field label="When you add files, should the AI see them by default?">
                <RadioGroup
                  value={inclusion}
                  onChange={(_, d) =>
                    void setDefaultInclusion(d.value === "exclude" ? "exclude" : "include")
                  }
                >
                  <Radio
                    value="include"
                    label="Include everything by default — files are searchable as soon as you add them (toggle off anything you want to hide)"
                  />
                  <Radio
                    value="exclude"
                    label="Keep files out by default — nothing is searchable until you include it"
                  />
                </RadioGroup>
                <Text className={styles.prefHint}>
                  Only affects files you add from now on; files you&apos;ve already included or
                  excluded keep their setting.
                </Text>
              </Field>

              {/* Bulk curation rules (openspec: add-curation-rules): every rule
                  across every folder, scope-named and removable. Creation lives
                  on the folder itself (right-click → Rules for this folder…). */}
              <Field label="Curation rules">
                {rules.length === 0 ? (
                  <Text className={styles.prefHint}>
                    No rules yet. Right-click a folder in Files and choose &ldquo;Rules for this
                    folder…&rdquo; to decide matching files — present and future — in one move.
                  </Text>
                ) : (
                  <div className={styles.ruleList}>
                    {rules.map((r) => (
                      <div key={r.id} className={styles.ruleRow}>
                        <Text size={200} className={styles.ruleName} title={r.name}>
                          {r.name}
                        </Text>
                        <Badge size="small" appearance="tint" color="brand">
                          {RULE_ACTION_LABEL[r.action] ?? r.action}
                        </Badge>
                        <Text
                          size={200}
                          className={
                            r.orphaned
                              ? mergeClasses(styles.prefHint, styles.ruleOrphan)
                              : styles.prefHint
                          }
                          title={
                            r.orphaned
                              ? "This folder no longer exists — the rule matches nothing until it returns"
                              : undefined
                          }
                        >
                          {r.scopeLabel}
                        </Text>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<DeleteRegular />}
                          aria-label={`Remove rule ${r.name}`}
                          onClick={() => void removeRule(r.id)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {rules.length > 0 && (
                  <Text className={styles.prefHint}>
                    Rules decide matching files where you haven&apos;t set one yourself; removing a
                    rule only undoes what it decided.
                  </Text>
                )}
              </Field>

              <LhSwitch
                checked={locks?.chatHistoryOff ? false : saveChats}
                disabled={locks?.chatHistoryOff === true}
                onChange={(_, d) => {
                  const on = Boolean(d.checked);
                  setSaveChats(on);
                  // G6 fail-closed: opting out also deletes every auto-exported
                  // chat note (Lighthouse Notes/Chats/), so nothing of the user's
                  // conversations survives on disk.
                  if (!on) void ragService.purgeConversationNotes().catch(() => {});
                }}
                label="Save chats on this device — kept locally and cleared automatically after two weeks (off by default; delete any chat from the history panel)"
              />
              {locks?.chatHistoryOff && (
                <Text className={styles.prefHint}>Managed by your organization.</Text>
              )}

              {/* Desktop settings hydrate here. Show a spinner while loading and
                  a retry on failure, so a transient error never masquerades as
                  "this build has no desktop options". */}
              {settingsLoad === "loading" && (
                <div className={styles.prefLoadingRow}>
                  <Spinner size="tiny" />
                  <Text size={200} className={styles.prefHint}>
                    Loading your settings…
                  </Text>
                </div>
              )}
              {settingsLoad === "error" && (
                <div className={styles.prefLoadingRow}>
                  <Text size={200} className={styles.error}>
                    Couldn&apos;t load your settings — some options may be unavailable.
                  </Text>
                  <Button
                    size="small"
                    appearance="secondary"
                    onClick={() => setReloadKey((k) => k + 1)}
                  >
                    Retry
                  </Button>
                </div>
              )}

              {desktop && (
                <LhSwitch
                  checked={runOnStartup}
                  onChange={(_, d) => updateStartup(Boolean(d.checked))}
                  label="Open Lighthouse when I sign in to my computer"
                />
              )}

              {desktop && (
                <LhSwitch
                  checked={semanticSearch}
                  onChange={(_, d) => updateSemantic(Boolean(d.checked))}
                  label="Semantic search — a small bundled model (runs entirely on this computer) helps questions find files by meaning, not just matching words"
                />
              )}

              {desktop && (
                <LhSwitch
                  checked={draftAnswers}
                  onChange={(_, d) => updateDraftAnswers(Boolean(d.checked))}
                  label="Show an instant draft answer while the private model works — an extractive preview from your files, replaced in place the moment the verified answer is ready"
                />
              )}

              {desktop && (
                <LhSwitch
                  checked={briefingNotify}
                  onChange={(_, d) => updateBriefingNotify(Boolean(d.checked))}
                  label="Notify me when the daily briefing note updates — a Lighthouse Notes file that refreshes when a pinned question's answer changes (the note is always written; this only controls the notification)"
                />
              )}

              {desktop && briefingNotify && (
                <div className={styles.prefRow}>
                  <Text className={styles.prefHint}>Refresh the briefing note after</Text>
                  <Dropdown
                    size="small"
                    selectedOptions={[String(briefingNoteHour)]}
                    value={`${briefingNoteHour % 12 === 0 ? 12 : briefingNoteHour % 12} ${briefingNoteHour < 12 ? "AM" : "PM"}`}
                    onOptionSelect={(_, d) => updateBriefingHour(Number(d.optionValue))}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <Option key={h} value={String(h)}>
                        {`${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`}
                      </Option>
                    ))}
                  </Dropdown>
                </div>
              )}

              {desktop && (
                <>
                  <LhSwitch
                    checked={locks?.ocrOff ? false : ocrEnabled}
                    disabled={locks?.ocrOff === true}
                    onChange={(_, d) => updateOcr(Boolean(d.checked))}
                    label="Read text in images — bundled models pull the words out of screenshots and scanned PDFs so they're searchable (runs on this computer; nothing is uploaded)"
                  />
                  {locks?.ocrOff && (
                    <Text className={styles.prefHint}>Managed by your organization.</Text>
                  )}
                </>
              )}

              {desktop && (
                <>
                  <LhSwitch
                    checked={locks?.auditLogOn ? true : auditEnabled}
                    disabled={locks?.auditLogOn === true}
                    onChange={(_, d) => updateAudit(Boolean(d.checked))}
                    label="Keep a local audit log — record what the assistant read, which provider answered, and what left this computer, for each question. Stored only on this computer; never uploaded."
                  />
                  {locks?.auditLogOn && (
                    <Text className={styles.prefHint}>Managed by your organization.</Text>
                  )}
                </>
              )}

              {desktop && uiMode !== "widget" && (
                <LhSwitch
                  checked={backgroundConserve}
                  onChange={(_, d) => updateConserve(Boolean(d.checked))}
                  label="Conserve resources in the background — free up the local AI's memory and CPU while Lighthouse sits in the tray or unfocused, and bring it back when you return (adds a couple of seconds to the first answer after you come back)"
                />
              )}

              {desktop && (
                <Field label="Interface">
                  <RadioGroup
                    value={uiMode}
                    onChange={(_, d) => updateUiMode(d.value === "widget" ? "widget" : "window")}
                  >
                    <Radio value="window" label="Window mode — the regular app window" />
                    <Radio
                      value="widget"
                      label="Widget mode (experimental) — a floating search bar lives on your desktop; the main window stays in the tray until you open it"
                    />
                  </RadioGroup>
                  <Text className={styles.prefHint}>
                    {hotkeyOk
                      ? `In either mode, ${summonHotkey()} summons the search bar from anywhere.`
                      : "Your system doesn't support the global shortcut — summon the search bar with the tray icon's “Show search bar”."}
                  </Text>
                </Field>
              )}

              {/* Managed policy: with hotkeys locked, the recorder is replaced
                  by the managed note — the shell never registers the chord. */}
              {desktop && locks?.widgetHotkeysOff && (
                <Field label="Summon shortcut">
                  <Text className={styles.prefHint}>
                    Summon shortcuts are managed off by your organization.
                  </Text>
                </Field>
              )}
              {/* Only when a keyed shortcut can actually register — hidden on
                  Wayland (summonHotkeyOk === false), where no global hotkey works. */}
              {desktop && hotkeyOk && !locks?.widgetHotkeysOff && (
                <Field label="Summon shortcut">
                  {recording ? (
                    <div className={styles.shortcutRow}>
                      <Input
                        className={styles.full}
                        autoFocus
                        readOnly
                        value=""
                        placeholder="Press keys…"
                        aria-label="Record a new summon shortcut"
                        onKeyDown={onRecordKeyDown}
                        onBlur={() => setRecording(false)}
                      />
                      <Button size="small" appearance="subtle" onClick={() => setRecording(false)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className={styles.shortcutRow}>
                      <Text className={styles.shortcutValue}>{prettyShortcut(summonShortcut)}</Text>
                      <Button
                        size="small"
                        aria-label="Record a new summon shortcut"
                        onClick={() => {
                          setShortcutError(null);
                          setRecording(true);
                        }}
                      >
                        Change
                      </Button>
                      <Button size="small" appearance="subtle" onClick={resetShortcut}>
                        Reset to default
                      </Button>
                    </div>
                  )}
                  {shortcutError && <Text className={styles.error}>{shortcutError}</Text>}
                  <Text className={styles.prefHint}>
                    Press this combination anywhere to summon the floating search bar.
                  </Text>
                </Field>
              )}

              {desktop && whisperCapable && !locks?.widgetHotkeysOff && (
                <Field label="Whisper summon (experimental)">
                  <LhSwitch
                    checked={whisperMode}
                    onChange={(_, d) => updateWhisper(Boolean(d.checked))}
                    label={`Tap ${whisperChord} — all three together, nothing else — to summon the search bar`}
                  />
                  {whisperMode && whisperPermission === "pending" && (
                    <Text className={styles.prefWarn}>
                      Waiting for Accessibility permission — enable Lighthouse in System Settings →
                      Privacy &amp; Security → Accessibility, then it starts automatically.
                    </Text>
                  )}
                  {whisperMode && whisperPermission === "failed" && (
                    <Text className={styles.error}>
                      The whisper listener couldn&apos;t start, so the tap isn&apos;t active —
                      antivirus tools sometimes block keyboard listeners. Try turning it off and
                      on again, or restart Lighthouse. The {summonHotkey()} shortcut works either
                      way.
                    </Text>
                  )}
                  <Text className={styles.prefHint}>
                    {isMac
                      ? `Uses macOS Accessibility while enabled; the ${summonHotkey()} shortcut keeps working either way.`
                      : `Uses a Windows keyboard hook while enabled; the ${summonHotkey()} shortcut keeps working either way.`}
                  </Text>
                </Field>
              )}

              {/* A failed optimistic write is rolled back above; say so here. */}
              {saveError && (
                <Text size={200} className={styles.error}>
                  {saveError}
                </Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}

/**
 * About — the quiet identity card: name and version, the Beam identity line,
 * what Beam (the built-in analytics engine) is, the three-egress privacy
 * sentence, and the download site. The version rides the same build-time
 * NEXT_PUBLIC_APP_VERSION as VersionBadge; when it's absent (plain web dev)
 * the line shows the name alone.
 */
export function AboutDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>About Lighthouse</DialogTitle>
          <DialogContent>
            <div className={styles.aboutStack}>
              <span className={styles.aboutBand} aria-hidden />
              <Text>
                <Text as="span" weight="semibold">
                  Lighthouse
                </Text>
                {version && (
                  <Text as="span" className={styles.aboutVersion}>
                    {" "}v{version}
                  </Text>
                )}
              </Text>
              <Text className={styles.aboutIdentity}>Ink, paper, and one amber beam.</Text>
              <Text>
                Answers come from your own files, on your own machine. Beam, the
                built-in analytics engine, computes figures with SQL it runs on this
                device — and shows the query behind every number.
              </Text>
              <Text>
                Only three kinds of request ever leave this machine: asks to a cloud
                model you set up, an update check, and downloads you start. No
                accounts, no telemetry.
              </Text>
              <Link href="https://lhvault.app" target="_blank" rel="noreferrer">
                lhvault.app
              </Link>
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}

/**
 * 0.13.10 §3: a plain dialog host for the relocated management surfaces
 * (Business definitions / Saved views) — the desktop counterpart of the
 * Settings page's inline groups, so both platforms reach the same components.
 */
function NavDialog({
  title,
  open,
  setOpen,
  children,
}: {
  title: string;
  open: boolean;
  setOpen: (b: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>{children}</DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}

export function SettingsMenu() {
  const styles = useStyles();
  const [aiDlg, setAiDlg] = useState(false);
  const [prefDlg, setPrefDlg] = useState(false);
  const [auditDlg, setAuditDlg] = useState(false);
  const [aboutDlg, setAboutDlg] = useState(false);
  // 0.13.10 §3: the relocated management surfaces (the Sections rail is gone).
  const [semanticDlg, setSemanticDlg] = useState(false);
  const [viewsDlg, setViewsDlg] = useState(false);

  // Other features (chat empty states, explorer hints, …) deep-link into these
  // dialogs by dispatching window CustomEvents — the menu owns the dialogs, so
  // it's the one place that listens. Mounted once, cleaned up on unmount.
  useEffect(() => {
    const openAiModels = () => setAiDlg(true);
    const openPreferences = () => setPrefDlg(true);
    window.addEventListener("lighthouse:open-ai-models", openAiModels);
    window.addEventListener("lighthouse:open-preferences", openPreferences);
    return () => {
      window.removeEventListener("lighthouse:open-ai-models", openAiModels);
      window.removeEventListener("lighthouse:open-preferences", openPreferences);
    };
  }, []);

  return (
    <>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            size="small"
            icon={<SettingsRegular />}
            aria-label="Settings"
            data-tour="settings"
          />
        </MenuTrigger>
        <LhMenuPopover>
          <MenuList>
            <MenuItem icon={<OptionsRegular />} onClick={() => setPrefDlg(true)}>
              <span className={styles.menuItemRow}>
                Preferences
                <span className={styles.menuShortcut}>{modKey()}+,</span>
              </span>
            </MenuItem>
            <MenuItem icon={<BrainCircuitRegular />} onClick={() => setAiDlg(true)}>
              AI models
            </MenuItem>
            <MenuItem
              icon={<PinRegular />}
              onClick={() =>
                // The chat panel owns pin data + the dialog; open it by event
                // (same cross-feature seam as new-chat / browse-files).
                window.dispatchEvent(new CustomEvent("lighthouse:open-pins"))
              }
            >
              Pinned questions
            </MenuItem>
            <MenuItem
              icon={<BoardRegular />}
              onClick={() =>
                // The board host (app/page.tsx) owns the panel; same seam
                // as open-pins (openspec: add-boards §2.2).
                window.dispatchEvent(new CustomEvent("lighthouse:open-board"))
              }
            >
              Board
            </MenuItem>
            {/* 0.13.10 §3: the relocated management surfaces. */}
            <MenuItem icon={<BookRegular />} onClick={() => setSemanticDlg(true)}>
              Business definitions
            </MenuItem>
            <MenuItem icon={<LibraryRegular />} onClick={() => setViewsDlg(true)}>
              Saved views
            </MenuItem>
            <MenuItem
              icon={<LightbulbRegular />}
              onClick={() => window.dispatchEvent(new Event("lighthouse:open-feedback"))}
            >
              Send feedback
            </MenuItem>
            <MenuItem icon={<HistoryRegular />} onClick={() => setAuditDlg(true)}>
              Audit log
            </MenuItem>
            <MenuItem
              icon={<QuestionCircleRegular />}
              onClick={() => window.dispatchEvent(new Event(START_TOUR_EVENT))}
            >
              Take the tour
            </MenuItem>
            <MenuItem
              icon={<OpenRegular />}
              onClick={() => window.open(LH_REPO, "_blank", "noopener,noreferrer")}
            >
              Lighthouse on GitHub
            </MenuItem>
            <MenuItem icon={<InfoRegular />} onClick={() => setAboutDlg(true)}>
              About Lighthouse
            </MenuItem>
          </MenuList>
        </LhMenuPopover>
      </Menu>
      <AiModelsDialog open={aiDlg} setOpen={setAiDlg} />
      <PreferencesDialog open={prefDlg} setOpen={setPrefDlg} />
      <AuditLogDialog open={auditDlg} setOpen={setAuditDlg} />
      <AboutDialog open={aboutDlg} setOpen={setAboutDlg} />
      <NavDialog title="Business definitions" open={semanticDlg} setOpen={setSemanticDlg}>
        <SemanticNav />
      </NavDialog>
      <NavDialog title="Saved views" open={viewsDlg} setOpen={setViewsDlg}>
        <ViewsNav />
      </NavDialog>
    </>
  );
}
