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
  fab: {
    position: "fixed",
    right: tokens.spacingHorizontalL,
    bottom: tokens.spacingVerticalL,
    zIndex: 900,
    minWidth: "auto",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    boxShadow: tokens.shadow8,
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
        if (!d.open) reset();
      }}
    >
      <DialogTrigger disableButtonEnhancement>
        <Tooltip content="Report a bug" relationship="label">
          <Button className={styles.fab} appearance="primary" icon={<BugRegular />} aria-label="Report a bug" />
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
                <Field label="Describe where the bug is happening">
                  <Textarea value={where} onChange={(_, d) => setWhere(d.value)} />
                </Field>
                <Field label="Describe the bug">
                  <Textarea value={what} onChange={(_, d) => setWhat(d.value)} />
                </Field>
                {err && <Text className={styles.error}>{err}</Text>}
              </div>
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
                  disabled={busy || (!where.trim() && !what.trim())}
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
