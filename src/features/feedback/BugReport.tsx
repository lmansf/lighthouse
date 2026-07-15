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
  Text,
  Textarea,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { ChatHelpRegular, MailRegular, OpenRegular } from "@fluentui/react-icons";
import { buildFeedbackMailto, buildFeedbackIssueUrl } from "@/lib/feedbackLinks";

/**
 * The single "Send feedback" flow. A quiet FAB in the corner (and a "Send
 * feedback" item in the settings menu, which dispatches `lighthouse:open-feedback`)
 * opens this dialog.
 *
 * PRIVACY CONTRACT — the app transmits NOTHING. The dialog composes the report
 * locally (your message, the app version, the OS, and — only if you tick the
 * box — a shell.log excerpt you review in full) and hands it off two ways you
 * complete yourself: "Email us" opens your mail client (mailto:), "Open a GitHub
 * issue" opens your browser with the report prefilled. No account id, email,
 * file, file name, or file content is ever attached, and Lighthouse makes no
 * network request of its own.
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
  // The "here's exactly what will be handed off" disclosure panel.
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
  handoffs: { display: "flex", gap: tokens.spacingHorizontalS },
});

/** Coarse OS label from the user agent — no API needed. */
function detectOs(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux|X11|CrOS/i.test(ua)) return "Linux";
  return "";
}

/** Open an external target (mail client / browser) — the same escape the
 *  settings-menu GitHub link uses, so the webview never navigates itself. */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function BugReport() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState("");
  const [what, setWhat] = useState("");
  const [includeLog, setIncludeLog] = useState(false);
  const [log, setLog] = useState("");
  const [logLoaded, setLogLoaded] = useState(false);

  // Version is injected at build time; OS is read client-side. Neither needs a
  // server round-trip — only the optional shell.log excerpt does (desktop only).
  const version = process.env.NEXT_PUBLIC_APP_VERSION || "";
  const os = detectOs();

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
    setLog("");
    setLogLoaded(false);
  }

  // Fetch the shell.log excerpt lazily — only if the user asks to include it.
  // Read-only; the web build has no shell.log so this returns "".
  async function loadLog() {
    if (logLoaded) return;
    try {
      const r = await fetch("/api/diagnostics");
      const d = (await r.json().catch(() => ({}))) as { log?: string };
      setLog(typeof d.log === "string" ? d.log : "");
    } catch {
      setLog("");
    } finally {
      setLogLoaded(true);
    }
  }

  const report = {
    where,
    what,
    version,
    os,
    log: includeLog && log.trim() ? log : undefined,
  };
  const canSend = Boolean(what.trim());
  const hasLog = includeLog && logLoaded && Boolean(log.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        setOpen(d.open);
        if (d.open) reset();
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
          <DialogTitle>Send feedback</DialogTitle>
          <DialogContent>
            <div className={styles.fields}>
              <Field label="Where in the app? (optional)">
                <Textarea value={where} onChange={(_, d) => setWhere(d.value)} />
              </Field>
              <Field label="What happened, or what would you change?" required>
                <Textarea value={what} onChange={(_, d) => setWhat(d.value)} />
              </Field>

              {/* Exactly what a handoff carries — shown before either button. */}
              <div className={styles.disclose}>
                <Text className={styles.discloseHead}>What gets handed off</Text>
                <Text className={styles.meta}>
                  Your message above, plus Lighthouse {version || "(version)"} on {os || "(your OS)"}.
                  Never your account, files, their names, or their contents. Lighthouse sends nothing
                  itself — the buttons below open your mail app or browser for you to send.
                </Text>
                <Checkbox
                  checked={includeLog}
                  onChange={(_, d) => {
                    const on = Boolean(d.checked);
                    setIncludeLog(on);
                    if (on) void loadLog();
                  }}
                  label="Attach a recent diagnostics excerpt (shell.log) to help debugging"
                />
                {includeLog &&
                  (hasLog ? (
                    <pre className={styles.logBox} aria-label="Diagnostics excerpt to be included">
                      {log}
                    </pre>
                  ) : (
                    <Text className={styles.meta}>
                      {logLoaded
                        ? "No diagnostics are available on this platform — nothing extra will be attached."
                        : "Loading diagnostics…"}
                    </Text>
                  ))}
                <Text className={styles.meta}>Note: GitHub issues are public.</Text>
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
            <div className={styles.handoffs}>
              <Button
                appearance="secondary"
                icon={<OpenRegular />}
                disabled={!canSend}
                onClick={() => openExternal(buildFeedbackIssueUrl(report))}
              >
                Open a GitHub issue
              </Button>
              <Button
                appearance="primary"
                icon={<MailRegular />}
                disabled={!canSend}
                onClick={() => openExternal(buildFeedbackMailto(report))}
              >
                Email us
              </Button>
            </div>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
