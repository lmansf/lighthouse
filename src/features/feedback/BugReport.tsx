"use client";

import { useState } from "react";
import {
  Button,
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
  tokens,
} from "@fluentui/react-components";
import { BugRegular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  // A quiet neutral affordance, not a brand-primary blob: parked in the corner
  // it shouldn't compete with the app's real primary actions.
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
});

/**
 * A small bug icon parked in the bottom-right corner. Opens a two-field report
 * ("where" + "what") that's sent to Supabase, with a thank-you on success.
 */
export function BugReport() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState("");
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setWhere("");
    setWhat("");
    setBusy(false);
    setDone(false);
    setErr(null);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/license", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "bug", bug: { where, what } }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.ok) setDone(true);
      else setErr("Couldn't send the report. Please try again.");
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        setOpen(d.open);
        // Reset on OPEN, not just close. The "Close" button below calls
        // setOpen(false) directly, which never fires onOpenChange — so a
        // close-then-reopen used to keep `done`/the old text, stranding the
        // user on the "Thank you!" screen forever (one report per session).
        // Resetting on every open guarantees a fresh form each time.
        if (d.open) reset();
      }}
    >
      <DialogTrigger disableButtonEnhancement>
        <Tooltip content="Report a bug" relationship="label">
          <Button className={styles.fab} appearance="subtle" icon={<BugRegular />} aria-label="Report a bug" />
        </Tooltip>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{done ? "Thank you!" : "Report a bug"}</DialogTitle>
          <DialogContent>
            {done ? (
              <Text className={styles.thanks}>
                Thanks for taking the time to report this — it helps make Lighthouse
                better.
              </Text>
            ) : (
              <div className={styles.fields}>
                <Field label="Where is the bug happening? (optional)">
                  <Textarea value={where} onChange={(_, d) => setWhere(d.value)} />
                </Field>
                <Field label="Describe the bug" required>
                  <Textarea value={what} onChange={(_, d) => setWhat(d.value)} />
                </Field>
                {err && <Text className={styles.error}>{err}</Text>}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {done ? (
              <>
                {/* Let the user file another report right away, without having
                    to close and reopen the dialog. */}
                <Button appearance="secondary" onClick={reset}>
                  Report another
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
                  {busy ? "Sending…" : "Send report"}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
