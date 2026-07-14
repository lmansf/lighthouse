"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Spinner,
  Text,
  Textarea,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { ChatHelpRegular } from "@fluentui/react-icons";

/**
 * The single explicit feedback channel. A quiet affordance in the corner (and a
 * "Send feedback" item in the settings menu, which dispatches
 * `lighthouse:open-feedback`) opens this form.
 *
 * PRIVACY CONTRACT: nothing leaves the machine until the user presses Send, and
 * the form shows EXACTLY what a Send will transmit — the message they typed,
 * plus the app version and OS — before they press it. An off-by-default
 * checkbox can attach a short diagnostics excerpt (the desktop shell.log),
 * rendered inline first so the user reads it before choosing to include it. No
 * account id, email, file, file name, or file content is ever attached.
 */

const useStyles = makeStyles({
  fab: {
    position: "fixed",
    right: tokens.spacingHorizontalL,
    bottom: tokens.spacingVerticalL,
    zIndex: 900,
    minWidth: "auto",
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground3,
    boxShadow: tokens.shadow8,
    ":hover": { color: tokens.colorNeutralForeground1 },
  },
  fields: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  thanks: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  // The "here's exactly what will be sent" disclosure panel.
  disclose: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  discloseHead: { fontWeight: tokens.fontWeightSemibold },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  logBox: {
    maxHeight: "160px",
    overflowY: "auto",
    margin: 0,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
});

interface Diagnostics {
  version: string;
  os: string;
  log: string;
}

export function BugReport() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState("");
  const [what, setWhat] = useState("");
  const [includeLog, setIncludeLog] = useState(false);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Openable from the settings menu ("Send feedback") without prop-drilling.
  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener("lighthouse:open-feedback", openIt);
    return () => window.removeEventListener("lighthouse:open-feedback", openIt);
  }, []);

  function reset() {
    setWhere("");
    setWhat("");
    setIncludeLog(false);
    setBusy(false);
    setDone(false);
    setErr(null);
  }

  // Fetch what-will-be-sent (version, OS, and the diagnostics excerpt) when the
  // dialog opens, so the disclosure shows the truth before any Send.
  async function loadDiagnostics() {
    try {
      const r = await fetch("/api/license", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "diagnostics" }),
      });
      const d = (await r.json().catch(() => ({}))) as Partial<Diagnostics>;
      setDiag({
        version: typeof d.version === "string" ? d.version : "",
        os: typeof d.os === "string" ? d.os : "",
        log: typeof d.log === "string" ? d.log : "",
      });
    } catch {
      setDiag({ version: "", os: "", log: "" });
    }
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/license", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "bug", where, what, includeLog }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.ok) setDone(true);
      else setErr("Couldn't send. Please try again.");
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const hasLog = Boolean(diag?.log && diag.log.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        setOpen(d.open);
        if (d.open) {
          reset();
          void loadDiagnostics();
        }
      }}
    >
      <DialogTrigger disableButtonEnhancement>
        <Tooltip content="Send feedback" relationship="label">
          <Button
            className={styles.fab}
            appearance="subtle"
            icon={<ChatHelpRegular />}
            aria-label="Send feedback"
          />
        </Tooltip>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{done ? "Thank you!" : "Send feedback"}</DialogTitle>
          <DialogContent>
            {done ? (
              <Text className={styles.thanks}>
                Thanks for taking the time — it helps make Lighthouse better.
              </Text>
            ) : (
              <div className={styles.fields}>
                <Field label="Where in the app? (optional)">
                  <Textarea value={where} onChange={(_, d) => setWhere(d.value)} />
                </Field>
                <Field label="What happened, or what would you change?" required>
                  <Textarea value={what} onChange={(_, d) => setWhat(d.value)} />
                </Field>

                {/* Exactly what a Send transmits — shown before the button. */}
                <div className={styles.disclose}>
                  <Text className={styles.discloseHead}>What gets sent</Text>
                  <Text className={styles.meta}>
                    Your message above, plus Lighthouse {diag?.version || "(version)"} on{" "}
                    {diag?.os || "(your OS)"}. Never your account, files, their names, or their
                    contents.
                  </Text>
                  <Checkbox
                    checked={includeLog}
                    onChange={(_, d) => setIncludeLog(Boolean(d.checked))}
                    label="Attach a recent diagnostics excerpt (shell.log) to help debugging"
                  />
                  {includeLog &&
                    (hasLog ? (
                      <pre className={styles.logBox} aria-label="Diagnostics excerpt to be sent">
                        {diag?.log}
                      </pre>
                    ) : (
                      <Text className={styles.meta}>
                        No diagnostics are available on this platform — nothing extra will be
                        attached.
                      </Text>
                    ))}
                </div>

                {err && <Text className={styles.error}>{err}</Text>}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {done ? (
              <>
                <Button appearance="secondary" onClick={reset}>
                  Send another
                </Button>
                <Button appearance="primary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </>
            ) : (
              <>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button
                  appearance="primary"
                  disabled={busy || !what.trim()}
                  icon={busy ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void submit()}
                >
                  {busy ? "Sending…" : "Send"}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
