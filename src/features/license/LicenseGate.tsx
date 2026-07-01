"use client";

import { useEffect, useState } from "react";
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
  Spinner,
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
  SettingsRegular,
  SignOutRegular,
  StarRegular,
} from "@fluentui/react-icons";
import { MODEL_PROVIDERS } from "@/contracts";
import { LocalModelOption } from "@/features/localModel/LocalModelOption";
import { useLicenseStore, type FeedbackInput, type LicenseStatus } from "@/stores/useLicenseStore";
import { useAuthStore } from "@/stores/useAuthStore";

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
    email: "",
    easeOfUse: 5,
    overallValue: 5,
    liked: "",
    changeOrAdd: "",
    doNotContact: false,
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
      <Field label="Email">
        <Input type="email" value={f.email} onChange={(_, d) => set({ email: d.value })} />
      </Field>
      <Checkbox
        checked={f.doNotContact}
        onChange={(_, d) => set({ doNotContact: Boolean(d.checked) })}
        label="Do not contact me"
      />
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
        disabled={busy || !f.email.trim()}
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
 * locked. When paid is off, an ended trial shows the feedback form (with the
 * notify checkbox) first, then a thank-you and the registration choice. Other
 * locks — and everything when paid is on — go straight to the choice.
 */
export function LicenseGate({ status }: { status: LicenseStatus }) {
  const styles = useStyles();
  const paidEnabled = useLicenseStore((s) => s.paidEnabled);
  // null until the user advances; the entry step is derived each render so the
  // async paidEnabled config can't strand an expired trial on the feedback form.
  const [step, setStep] = useState<"feedback" | "thanks" | "choose" | null>(null);
  const resolvedStep = step ?? (status === "expired" && !paidEnabled ? "feedback" : "choose");

  return (
    <div className={styles.rail}>
      {resolvedStep === "feedback" && (
        <>
          <FeedbackForm mode="trial-end" onDone={() => setStep("thanks")} />
          <Button appearance="subtle" onClick={() => setStep("choose")}>
            Skip — I have a key or want to start a trial
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
      {resolvedStep === "choose" && <RegistrationChoice />}
    </div>
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

export function SettingsMenu() {
  const styles = useStyles();
  const paidEnabled = useLicenseStore((s) => s.paidEnabled);
  const user = useAuthStore((s) => s.onboarding.user);
  const signOut = useAuthStore((s) => s.signOut);
  const [dlg, setDlg] = useState(false);
  const [aiDlg, setAiDlg] = useState(false);

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
