"use client";

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Divider,
  Dropdown,
  Field,
  Input,
  Link,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Option,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  Text,
  Textarea,
  Title3,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  BrainCircuitRegular,
  KeyRegular,
  MailRegular,
  OpenRegular,
  OptionsRegular,
  QuestionCircleRegular,
  SettingsRegular,
  SignOutRegular,
  StarRegular,
} from "@fluentui/react-icons";
import { MODEL_PROVIDERS } from "@/contracts";
import { LocalModelOption, LocalModelInstallPanel } from "@/features/localModel/LocalModelOption";
import { QuickStartDialog } from "@/features/help/QuickStart";
import { showWidget, summonHotkey, prettyShortcut } from "@/features/onboarding/ModeChooser";
import { useLicenseStore, type FeedbackInput, type LicenseStatus } from "@/stores/useLicenseStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useThemeStore } from "@/stores/useThemeStore";

const LH_REPO = "https://github.com/lmansf/lighthouse";

const useStyles = makeStyles({
  rail: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    ...shorthands.padding(tokens.spacingVerticalXL, tokens.spacingHorizontalL),
    height: "100%",
    width: "100%",
    maxWidth: "440px",
    marginLeft: "auto",
    marginRight: "auto",
    boxSizing: "border-box",
    overflowY: "auto",
  },
  beaconRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  beacon: {
    width: "12px",
    height: "12px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 10px 2px ${tokens.colorBrandBackground}`,
  },
  body: { color: tokens.colorNeutralForeground2 },
  full: { width: "100%" },
  scores: { display: "flex", gap: tokens.spacingHorizontalXS },
  scoreBtn: { minWidth: "36px" },
  // The prominent slot — Subscribe (paid on) or "Get notified" (paid off).
  cta: { height: "52px", fontSize: tokens.fontSizeBase400 },
  price: { fontWeight: tokens.fontWeightSemibold },
  // Trial: greyed but comes alive on hover — only when paid mode is on (then the
  // subscribe CTA is the headline). When paid is off, the trial is the real CTA.
  trialGhost: {
    opacity: 0.5,
    filter: "grayscale(0.7)",
    transition: "opacity 120ms ease, filter 120ms ease",
    ":hover": { opacity: 1, filter: "grayscale(0)" },
    ":focus-within": { opacity: 1, filter: "grayscale(0)" },
  },
  activate: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, width: "100%" },
  row: { display: "flex", gap: tokens.spacingHorizontalS, width: "100%" },
  error: { color: tokens.colorPaletteRedForeground1 },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  highlightItem: {
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    backgroundColor: tokens.colorBrandBackground2,
  },
  profileHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    maxWidth: "280px",
  },
  profileText: { display: "flex", flexDirection: "column", minWidth: 0 },
  modelFields: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  savedNote: { color: tokens.colorPaletteGreenForeground1, fontSize: tokens.fontSizeBase200 },
  // Preferences dialog: sections separated by a little vertical air.
  prefFields: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  prefHint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  // Waiting-on-permission note under the whisper switch — warning tint so it
  // reads as "action needed" without the alarm of a hard error red.
  prefWarn: { color: tokens.colorStatusWarningForeground1, fontSize: tokens.fontSizeBase200 },
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
  // Opt-in feedback entry under the registration choice — deliberately quiet so
  // the choice stays the headline (the old flow gated it behind the survey).
  feedbackLink: { alignSelf: "center", fontSize: tokens.fontSizeBase200 },
  // Trial countdown pill in the sidebar footer. Neutral so it informs without
  // shouting; flips to warning colors when the trial is nearly over.
  trialPill: {
    height: "24px",
    minWidth: "auto",
    ...shorthands.padding(0, tokens.spacingHorizontalS),
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightRegular,
    whiteSpace: "nowrap",
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground3Hover,
      color: tokens.colorNeutralForeground2,
    },
  },
  trialPillUrgent: {
    backgroundColor: tokens.colorStatusWarningBackground2,
    color: tokens.colorStatusWarningForeground2,
    ":hover": {
      backgroundColor: tokens.colorStatusWarningBackground2,
      color: tokens.colorStatusWarningForeground2,
    },
  },
});

/** 0–5 rating as a compact segmented row. */
function Score({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const styles = useStyles();
  return (
    <Field label={label}>
      <div className={styles.scores}>
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <Button
            key={n}
            className={styles.scoreBtn}
            size="small"
            appearance={value === n ? "primary" : "outline"}
            onClick={() => onChange(n)}
          >
            {n}
          </Button>
        ))}
      </div>
    </Field>
  );
}

/** Inline "I have a license key" activation, used as a fallback under the choices. */
export function ActivateKey() {
  const styles = useStyles();
  const [key, setKey] = useState("");
  const activate = useLicenseStore((s) => s.activate);
  const activating = useLicenseStore((s) => s.activating);
  const activateError = useLicenseStore((s) => s.activateError);

  return (
    <div className={styles.activate}>
      <Text className={styles.muted}>Already have a license key?</Text>
      <div className={styles.row}>
        <Input
          className={styles.full}
          value={key}
          placeholder="Paste your license key"
          contentBefore={<KeyRegular />}
          onChange={(_, d) => setKey(d.value)}
        />
        <Button
          disabled={activating || !key.trim()}
          icon={activating ? <Spinner size="tiny" /> : undefined}
          onClick={() => void activate(key.trim())}
        >
          {activating ? "Checking…" : "Activate"}
        </Button>
      </div>
      {activateError && <Text className={styles.error}>{activateError}</Text>}
    </div>
  );
}

/**
 * The email-capture dialog behind the prominent "buy" slot. When paid mode is on
 * it starts Stripe checkout; when off it records "notify me when purchasing
 * opens" — same slot, so the location is consistent at launch.
 */
function PurchaseDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  const paidEnabled = useLicenseStore((s) => s.paidEnabled);
  const subscribe = useLicenseStore((s) => s.subscribe);
  const purchasing = useLicenseStore((s) => s.purchasing);
  const submitNotify = useLicenseStore((s) => s.submitNotify);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const emailOk = /.+@.+\..+/.test(email.trim());

  async function act() {
    if (paidEnabled) {
      void subscribe(email.trim());
      setOpen(false);
    } else {
      setBusy(true);
      const ok = await submitNotify(email.trim());
      setBusy(false);
      if (ok) setDone(true);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        setOpen(d.open);
        if (!d.open) setDone(false);
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {done ? "Thank you!" : paidEnabled ? "Subscribe — $14.99/month" : "Get notified"}
          </DialogTitle>
          <DialogContent>
            {done ? (
              <Text className={styles.body}>
                Thanks — we&apos;ll email you the moment purchasing opens.
              </Text>
            ) : (
              <>
                <Text className={styles.body}>
                  {paidEnabled
                    ? "Unlimited use of Lighthouse. The license is tied to this email — buying for a teammate? Use their address (several can go on one card)."
                    : "Purchasing isn't open yet. Leave your email and we'll let you know the moment it is."}
                </Text>
                <div style={{ marginTop: 12 }}>
                  <Field label="Email">
                    <Input
                      type="email"
                      value={email}
                      placeholder="name@company.com"
                      onChange={(_, d) => setEmail(d.value)}
                    />
                  </Field>
                </div>
              </>
            )}
          </DialogContent>
          <DialogActions>
            {done ? (
              <Button appearance="primary" onClick={() => setOpen(false)}>
                Close
              </Button>
            ) : (
              <>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button
                  appearance="primary"
                  disabled={busy || purchasing || !emailOk}
                  icon={busy || purchasing ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void act()}
                >
                  {paidEnabled ? "Continue to checkout" : busy ? "Submitting…" : "Notify me"}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Registration choice: the buy/notify slot, plus start-a-trial and activate. */
function RegistrationChoice() {
  const styles = useStyles();
  const paidEnabled = useLicenseStore((s) => s.paidEnabled);
  const startTrial = useLicenseStore((s) => s.startTrial);
  const starting = useLicenseStore((s) => s.starting);
  const startError = useLicenseStore((s) => s.startError);
  const purchasing = useLicenseStore((s) => s.purchasing);
  const cancelSubscribe = useLicenseStore((s) => s.cancelSubscribe);
  const [dlg, setDlg] = useState(false);

  return (
    <>
      <div className={styles.beaconRow}>
        <span className={styles.beacon} />
        <Title3>Keep using Lighthouse</Title3>
      </div>
      <Text className={styles.body}>
        {paidEnabled
          ? "Subscribe for unlimited use, or start another 14-day trial. Either way your vault stays exactly as it is."
          : "Start another 14-day trial — your vault stays exactly as it is. Want to buy when it's ready?"}
      </Text>

      {/* Prominent slot: Subscribe (paid on) or Get-notified (paid off). */}
      <Button
        className={mergeClasses(styles.full, styles.cta)}
        appearance="primary"
        icon={paidEnabled ? <StarRegular /> : <MailRegular />}
        onClick={() => setDlg(true)}
      >
        {paidEnabled ? (
          <span>
            Subscribe — <span className={styles.price}>$14.99/month</span>
          </span>
        ) : (
          "Get notified when purchasing opens"
        )}
      </Button>
      {paidEnabled && purchasing && (
        <>
          <Text className={styles.muted}>
            Complete your purchase in the browser — this unlocks automatically once
            payment goes through.
          </Text>
          <Button className={styles.full} appearance="subtle" size="small" onClick={() => cancelSubscribe()}>
            Cancel
          </Button>
        </>
      )}

      <Button
        className={mergeClasses(styles.full, paidEnabled ? styles.trialGhost : "")}
        appearance={paidEnabled ? "secondary" : "primary"}
        disabled={starting}
        icon={starting ? <Spinner size="tiny" /> : undefined}
        onClick={() => void startTrial()}
      >
        {starting ? "Starting…" : "Start a 14-day trial"}
      </Button>
      {startError && <Text className={styles.error}>{startError}</Text>}

      <Divider />
      <ActivateKey />
      <PurchaseDialog open={dlg} setOpen={setDlg} />
    </>
  );
}

/**
 * Feedback form. "post-purchase" runs after a subscription (no notify line);
 * "trial-end" runs when a trial ends while paid is off, and includes the
 * "email me when purchasing opens" checkbox; "mid-session" is the optional
 * nudge that surfaces after a while of use (issue: feedback nudge) — same form,
 * gentler copy. The `mode` only changes copy, so adding modes is safe.
 */
export function FeedbackForm({
  mode,
  onDone,
}: {
  mode: "trial-end" | "post-purchase" | "mid-session";
  onDone: () => void;
}) {
  const styles = useStyles();
  const submitFeedback = useLicenseStore((s) => s.submitFeedback);
  const paidEnabled = useLicenseStore((s) => s.paidEnabled);
  const [f, setF] = useState<FeedbackInput>({
    firstName: "",
    lastName: "",
    easeOfUse: 5,
    overallValue: 5,
    liked: "",
    changeOrAdd: "",
    notifyWhenAvailable: false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<FeedbackInput>) => setF((p) => ({ ...p, ...patch }));
  const showNotify = mode === "trial-end" && !paidEnabled;

  async function submit() {
    setBusy(true);
    setErr(null);
    const ok = await submitFeedback(f);
    setBusy(false);
    if (ok) onDone();
    else setErr("Couldn't send your feedback. Please check your connection and try again.");
  }

  return (
    <>
      <div className={styles.beaconRow}>
        <span className={styles.beacon} />
        <Title3>
          {mode === "post-purchase"
            ? "Thanks for subscribing!"
            : mode === "mid-session"
              ? "What do you think so far?"
              : "Your trial has ended"}
        </Title3>
      </div>
      <Text className={styles.body}>
        {mode === "post-purchase"
          ? "A couple of quick questions before you dive back in — your files are right where you left them."
          : mode === "mid-session"
            ? "You've been at it a little while — mind sharing a quick first impression? It really helps."
            : "Share a little feedback. Your files are safe and untouched."}
      </Text>

      <Field label="First name">
        <Input value={f.firstName} onChange={(_, d) => set({ firstName: d.value })} />
      </Field>
      <Field label="Last name">
        <Input value={f.lastName} onChange={(_, d) => set({ lastName: d.value })} />
      </Field>
      <Score label="Ease of use (0–5)" value={f.easeOfUse} onChange={(n) => set({ easeOfUse: n })} />
      <Score label="Overall value (0–5)" value={f.overallValue} onChange={(n) => set({ overallValue: n })} />
      <Field label="What's one feature you liked?">
        <Textarea value={f.liked} onChange={(_, d) => set({ liked: d.value })} />
      </Field>
      <Field label="What's one feature you would change or add?">
        <Textarea value={f.changeOrAdd} onChange={(_, d) => set({ changeOrAdd: d.value })} />
      </Field>
      {showNotify && (
        <Checkbox
          checked={Boolean(f.notifyWhenAvailable)}
          onChange={(_, d) => set({ notifyWhenAvailable: Boolean(d.checked) })}
          label="Email me when Lighthouse is available to purchase"
        />
      )}
      {err && <Text className={styles.error}>{err}</Text>}
      <Button
        className={styles.full}
        appearance="primary"
        disabled={busy}
        icon={busy ? <Spinner size="tiny" /> : undefined}
        onClick={() => void submit()}
      >
        {busy ? "Sending…" : mode === "post-purchase" ? "Submit & continue" : "Submit feedback"}
      </Button>
    </>
  );
}

/** Post-purchase survey shown in the rail after checkout, before chat reopens. */
export function PostPurchaseFeedback() {
  const styles = useStyles();
  const dismiss = useLicenseStore((s) => s.dismissFeedback);
  return (
    <div className={styles.rail}>
      <FeedbackForm mode="post-purchase" onDone={dismiss} />
      <Button appearance="subtle" onClick={dismiss}>
        Skip
      </Button>
    </div>
  );
}

/**
 * Lock gate shown in the LEFT RAIL while the vault (greyed in the main pane) is
 * locked. It lands directly on the registration choice — getting back in is the
 * user's goal, so the survey never blocks the door. An ended trial offers a
 * quiet opt-in "Share quick feedback" link under the choice instead, which runs
 * the trial-end form and returns to the choice via the thank-you step.
 */
export function LicenseGate({ status }: { status: LicenseStatus }) {
  const styles = useStyles();
  // null until the user navigates; the entry step is always the choice so
  // feedback stays opt-in (it used to gate an expired trial).
  const [step, setStep] = useState<"feedback" | "thanks" | "choose" | null>(null);
  const resolvedStep = step ?? "choose";

  return (
    <div className={styles.rail}>
      {resolvedStep === "feedback" && (
        <>
          <FeedbackForm mode="trial-end" onDone={() => setStep("thanks")} />
          <Button appearance="subtle" onClick={() => setStep("choose")}>
            Back
          </Button>
        </>
      )}
      {resolvedStep === "thanks" && (
        <>
          <div className={styles.beaconRow}>
            <span className={styles.beacon} />
            <Title3>Thank you!</Title3>
          </div>
          <Text className={styles.body}>
            Thanks for using Lighthouse and sharing your feedback — it genuinely
            helps. You can keep going below.
          </Text>
          <Button className={styles.full} appearance="primary" onClick={() => setStep("choose")}>
            Continue
          </Button>
        </>
      )}
      {resolvedStep === "choose" && (
        <>
          <RegistrationChoice />
          {/* Only a genuinely ended trial earns the trial-end feedback ask. */}
          {status === "expired" && (
            <Link appearance="subtle" className={styles.feedbackLink} onClick={() => setStep("feedback")}>
              Share quick feedback
            </Link>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Compact trial countdown for the sidebar footer: "Trial · N days left".
 * Renders only for a running trial with a known remaining-days count — every
 * other license state renders nothing, so it can be mounted unconditionally.
 * Clicking it opens the purchase dialog (subscribe / get-notified), making the
 * countdown itself the path to acting on it.
 */
export function TrialBadge() {
  const styles = useStyles();
  const status = useLicenseStore((s) => s.status);
  const licenseType = useLicenseStore((s) => s.licenseType);
  const remainingDays = useLicenseStore((s) => s.remainingDays);
  const [dlg, setDlg] = useState(false);

  if (licenseType !== "trial" || status !== "valid" || remainingDays == null) return null;

  // The last few days warrant the warning tint — before that, stay neutral.
  const urgent = remainingDays <= 3;

  return (
    <>
      <Button
        className={mergeClasses(styles.trialPill, urgent && styles.trialPillUrgent)}
        appearance="subtle"
        size="small"
        shape="circular"
        onClick={() => setDlg(true)}
      >
        Trial · {remainingDays} day{remainingDays === 1 ? "" : "s"} left
      </Button>
      <PurchaseDialog open={dlg} setOpen={setDlg} />
    </>
  );
}

/**
 * Settings menu for the left nav (a gear button). Surfaces a **highlighted**
 * item in the buy slot — "Subscribe" when paid is on, "Get notified when
 * purchasing opens" while it's off — plus a couple of basic items.
 */
/** First model of a provider id, falling back to the first known provider. */
function firstModelFor(pid: string): string {
  return (MODEL_PROVIDERS.find((p) => p.id === pid) ?? MODEL_PROVIDERS[0]).models[0];
}

/**
 * Manage the active model provider/model and API key after onboarding. Reuses
 * the same selectModel seam as the onboarding model step; the server preserves
 * the stored key when the field is left blank, so the user can switch model
 * without re-pasting their key.
 */
function AiModelsDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  const onboarding = useAuthStore((s) => s.onboarding);
  const selectModel = useAuthStore((s) => s.selectModel);

  const [providerId, setProviderId] = useState(onboarding.providerId ?? MODEL_PROVIDERS[0].id);
  const [modelId, setModelId] = useState(onboarding.modelId ?? firstModelFor(providerId));
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the fields to the saved settings on the open transition.
  useEffect(() => {
    if (!open) return;
    const current = useAuthStore.getState().onboarding;
    const pid = current.providerId ?? MODEL_PROVIDERS[0].id;
    setProviderId(pid);
    setModelId(current.modelId ?? firstModelFor(pid));
    setApiKey("");
    setSaved(false);
    setError(null);
  }, [open]);

  const provider = MODEL_PROVIDERS.find((p) => p.id === providerId) ?? MODEL_PROVIDERS[0];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Empty key ⇒ keep the existing one (selectModel falls back to the stored key).
      await selectModel(providerId, modelId, apiKey);
      setSaved(true);
      setOpen(false); // close immediately on success — no separate "Close" click
    } catch {
      setError("Couldn't save your model settings. Please check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>AI models</DialogTitle>
          <DialogContent>
            <div className={styles.modelFields}>
              <Field label="Provider">
                <Dropdown
                  value={provider.label}
                  selectedOptions={[providerId]}
                  onOptionSelect={(_, d) => {
                    const p = MODEL_PROVIDERS.find((x) => x.id === d.optionValue)!;
                    setProviderId(p.id);
                    setModelId(p.models[0]);
                    setSaved(false);
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
                  onOptionSelect={(_, d) => {
                    setModelId(d.optionValue!);
                    setSaved(false);
                  }}
                >
                  {provider.models.map((m) => (
                    <Option key={m} value={m}>
                      {m}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              {provider.id === "local" && <LocalModelInstallPanel />}
              {provider.id !== "local" && (
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
                      setSaved(false);
                    }}
                    placeholder={
                      onboarding.hasApiKey ? "•••••••• saved — leave blank to keep" : "sk-…"
                    }
                  />
                </Field>
              )}
              {error && <Text className={styles.error}>{error}</Text>}
              {saved && <Text className={styles.savedNote}>Saved.</Text>}
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
      </DialogSurface>
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
function PreferencesDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  const defaultInclusion = useAuthStore((s) => s.onboarding.defaultInclusion);
  const setDefaultInclusion = useAuthStore((s) => s.setDefaultInclusion);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  const [shareUsage, setShareUsage] = useState<boolean | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [runOnStartup, setRunOnStartup] = useState(true);
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

  // Load the file-backed prefs (usage consent, launch-at-login) when opened.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setShareUsage(!d.optOut))
      .catch(() => {});
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        setDesktop(Boolean(d.desktop));
        setRunOnStartup(d.runOnStartup !== false);
        setUiMode(d.uiMode === "widget" ? "widget" : "window");
        setWhisperMode(d.whisperMode === true);
        setWhisperPermission(typeof d.whisperPermission === "string" ? d.whisperPermission : "unknown");
        setSummonShortcut(
          typeof d.summonShortcut === "string" && d.summonShortcut
            ? d.summonShortcut
            : "ctrl+super+shift+space",
        );
        setHotkeyOk(d.summonHotkeyOk !== false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  const inclusion = defaultInclusion ?? "include";

  function updateUsage(next: boolean) {
    setShareUsage(next);
    void fetch("/api/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "consent", optOut: !next }),
    }).catch(() => {});
  }

  function updateStartup(next: boolean) {
    setRunOnStartup(next);
    void fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Flipping this IS startup consent — record startupAsked so the shell's
      // consent-first boot gate honors the choice (and the deferred startup
      // prompt stays quiet).
      body: JSON.stringify({ runOnStartup: next, startupAsked: true }),
    }).catch(() => {});
  }

  function updateUiMode(next: "window" | "widget") {
    setUiMode(next);
    void fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uiMode: next }),
    }).catch(() => {});
    // Make the switch tangible right away instead of "at next launch".
    if (next === "widget") void showWidget();
  }

  function updateWhisper(next: boolean) {
    setWhisperMode(next);
    // The shell starts/stops the keyboard hook live — no relaunch needed. On
    // macOS enabling may go "pending" while Accessibility is granted; re-read
    // the state (and poll briefly) so the waiting-for-permission note appears
    // in this same session instead of only after reopening Preferences.
    void fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ whisperMode: next }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.whisperPermission === "string") setWhisperPermission(d.whisperPermission);
      })
      .catch(() => {});
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
      setShortcutError("Couldn't save the shortcut. Please try again.");
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
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Preferences</DialogTitle>
          <DialogContent>
            <div className={styles.prefFields}>
              {/* First: appearance is the most-reached-for preference. Applies
                  instantly via the theme store — no save step. */}
              <Field label="Appearance">
                <RadioGroup
                  layout="horizontal"
                  value={themeMode}
                  onChange={(_, d) =>
                    setThemeMode(d.value === "light" || d.value === "dark" ? d.value : "system")
                  }
                >
                  <Radio value="light" label="Light" />
                  <Radio value="dark" label="Dark" />
                  <Radio value="system" label="Match system" />
                </RadioGroup>
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

              <Switch
                checked={shareUsage ?? false}
                disabled={shareUsage === null}
                onChange={(_, d) => updateUsage(Boolean(d.checked))}
                label="Share usage analytics — your account email and which features you use, never your files, their names, or their contents"
              />

              {desktop && (
                <Switch
                  checked={runOnStartup}
                  onChange={(_, d) => updateStartup(Boolean(d.checked))}
                  label="Launch Lighthouse when I sign in to my computer"
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

              {/* Only when a keyed shortcut can actually register — hidden on
                  Wayland (summonHotkeyOk === false), where no global hotkey works. */}
              {desktop && hotkeyOk && (
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

              {desktop && whisperCapable && (
                <Field label="Whisper summon (experimental)">
                  <Switch
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
                  <Text className={styles.prefHint}>
                    {isMac
                      ? `Uses macOS Accessibility while enabled; the ${summonHotkey()} shortcut keeps working either way.`
                      : `Uses a Windows keyboard hook while enabled; the ${summonHotkey()} shortcut keeps working either way.`}
                  </Text>
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function SettingsMenu() {
  const styles = useStyles();
  const paidEnabled = useLicenseStore((s) => s.paidEnabled);
  const user = useAuthStore((s) => s.onboarding.user);
  const signOut = useAuthStore((s) => s.signOut);
  const [dlg, setDlg] = useState(false);
  const [aiDlg, setAiDlg] = useState(false);
  const [prefDlg, setPrefDlg] = useState(false);
  const [quickStartDlg, setQuickStartDlg] = useState(false);

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
          <Button appearance="subtle" size="small" icon={<SettingsRegular />} aria-label="Settings" />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {user && (
              <>
                <div className={styles.profileHeader}>
                  <Avatar name={user.name} color="brand" size={32} />
                  <div className={styles.profileText}>
                    <Text weight="semibold" truncate>
                      {user.name}
                    </Text>
                    <Text size={200} className={styles.muted} truncate>
                      {user.email}
                    </Text>
                  </div>
                </div>
                <MenuItem icon={<SignOutRegular />} onClick={() => void signOut()}>
                  Sign out
                </MenuItem>
                <MenuDivider />
              </>
            )}
            <MenuItem icon={<OptionsRegular />} onClick={() => setPrefDlg(true)}>
              Preferences
            </MenuItem>
            <MenuItem icon={<BrainCircuitRegular />} onClick={() => setAiDlg(true)}>
              AI models
            </MenuItem>
            <MenuDivider />
            <MenuItem
              className={styles.highlightItem}
              icon={paidEnabled ? <StarRegular /> : <MailRegular />}
              onClick={() => setDlg(true)}
            >
              {paidEnabled ? "Subscribe — $14.99/month" : "Get notified when purchasing opens"}
            </MenuItem>
            <MenuDivider />
            <MenuItem icon={<QuestionCircleRegular />} onClick={() => setQuickStartDlg(true)}>
              Quick start
            </MenuItem>
            <MenuItem
              icon={<OpenRegular />}
              onClick={() => window.open(LH_REPO, "_blank", "noopener,noreferrer")}
            >
              Lighthouse on GitHub
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <PurchaseDialog open={dlg} setOpen={setDlg} />
      <AiModelsDialog open={aiDlg} setOpen={setAiDlg} />
      <PreferencesDialog open={prefDlg} setOpen={setPrefDlg} />
      <QuickStartDialog open={quickStartDlg} setOpen={setQuickStartDlg} />
    </>
  );
}

/** Grace banner for a lapsed PAID subscription that's still usable. */
export function GraceBanner({ graceUntil }: { graceUntil: string | null }) {
  const subscribe = useLicenseStore((s) => s.subscribe);
  const cancelSubscribe = useLicenseStore((s) => s.cancelSubscribe);
  const purchasing = useLicenseStore((s) => s.purchasing);
  const paidEnabled = useLicenseStore((s) => s.paidEnabled);
  const days = graceUntil
    ? Math.max(0, Math.ceil((Date.parse(graceUntil) - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 16,
        padding: "10px 20px",
        backgroundColor: tokens.colorStatusWarningBackground2,
        color: tokens.colorStatusWarningForeground2,
        borderBottom: `1px solid ${tokens.colorStatusWarningBorder1}`,
      }}
    >
      <Text weight="semibold">
        Your subscription has ended.
        {days !== null
          ? ` You have ${days} day${days === 1 ? "" : "s"} to renew before your vault is locked.`
          : " Renew to keep access before your vault is locked."}
      </Text>
      {paidEnabled && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <Button appearance="primary" size="small" disabled={purchasing} onClick={() => void subscribe("")}>
            {purchasing ? "Waiting…" : "Renew — $14.99/mo"}
          </Button>
          {purchasing && (
            <Button appearance="subtle" size="small" onClick={() => cancelSubscribe()}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {!paidEnabled && (
        <div style={{ marginLeft: "auto", minWidth: 280 }}>
          <ActivateKey />
        </div>
      )}
    </div>
  );
}
