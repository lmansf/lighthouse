"use client";

/**
 * Egress transparency shield (S3) — the "what left this machine" indicator.
 * A compact badge reads "All local" (nothing has been sent this session) or
 * "N to <host>"; clicking opens a per-destination panel (purpose + count +
 * last time — never content). Data is the session egress snapshot the rag
 * store refreshes on its shared poll; this component only reads it.
 *
 * §22.2 (declutter the top bar): the shield is ALSO the chat's one status
 * popover. The header's separate diagnostics — the "N files visible to AI"
 * badge, the On-device policy badge, and the "hidden from cloud" button —
 * collapsed into optional sections of this dialog, passed as props by the
 * owner (ChatPanel). All props are optional so existing prop-less mounts
 * (the widget summary path) are untouched.
 */
import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Text,
  makeStyles,
  tokens,
  shorthands,
} from "@fluentui/react-components";
import { IconGlobe, IconLock, IconShieldCheck } from "@/shell/icons";
import { useRagStore } from "@/stores/useRagStore";
import { LhDialogSurface } from "@/shell/controls";
import { usePaneLayout } from "@/shell/paneLayout";
import { hiddenFromCloudLabel } from "@/lib/privacyState";

const useStyles = makeStyles({
  trigger: {
    minWidth: "auto",
    ...shorthands.padding(0, tokens.spacingHorizontalXS),
  },
  // §2 (iOS field patch 2): in the compact arrangement the trigger is
  // icon-only and thumb-sized — the label text lives in the aria-label and
  // the dialog. On a 390pt header the full "N to <host>" badge clipped
  // mid-glyph (first-device report).
  triggerCompact: { minWidth: "44px", minHeight: "44px" },
  list: {
    display: "flex",
    flexDirection: "column",
    ...shorthands.gap(tokens.spacingVerticalS),
    marginTop: tokens.spacingVerticalS,
  },
  row: {
    display: "flex",
    flexDirection: "column",
    ...shorthands.gap("2px"),
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    ...shorthands.gap(tokens.spacingHorizontalM),
  },
  host: { fontWeight: tokens.fontWeightSemibold },
  sub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  allLocal: {
    display: "flex",
    alignItems: "center",
    ...shorthands.gap(tokens.spacingHorizontalS),
    color: tokens.colorNeutralForeground2,
  },
  revealBtn: { alignSelf: "flex-start", marginTop: tokens.spacingVerticalXS },
});

function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export interface EgressShieldProps {
  /** §22.2: files currently visible to AI — the count the header Badge used
   *  to carry, now a section of this dialog. Omit to leave it out. */
  visibleCount?: number;
  /** Files marked "Private — this device only" being withheld RIGHT NOW
   *  (owner passes 0 unless a cloud provider is active). 0/omitted hides it. */
  hiddenFromCloud?: number;
  /** Show the withheld files in the explorer — the old header button's
   *  action; the owner dispatches the filter + reveal events. */
  onRevealHidden?: () => void;
  /** This investigation always answers on-device (local-only policy) — the
   *  retired On-device badge's promise, kept truthful here. */
  onDeviceLocalOnly?: boolean;
}

export function EgressShield({
  visibleCount,
  hiddenFromCloud,
  onRevealHidden,
  onDeviceLocalOnly,
}: EgressShieldProps = {}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const egress = useRagStore((s) => s.egress);
  // §2: compact (mobile < 700px) collapses the trigger to its icon. Derived
  // from the shared paneLayout signal — false everywhere on desktop, so the
  // widget/desktop mounts render exactly as before.
  const compact = usePaneLayout(false).compact;

  // Until the first snapshot lands, say nothing (avoid a flash of "All local"
  // that could then flip). total 0 is the genuine All-local signal.
  if (!egress) return null;

  const local = egress.total === 0;
  const primaryHost = egress.destinations[0]?.host;
  const label = local
    ? "All local"
    : egress.destinations.length === 1
      ? `${egress.total} to ${primaryHost}`
      : `${egress.total} requests · ${egress.destinations.length} hosts`;

  // §22.2: any status prop present makes this the chat's combined popover.
  const withheld = hiddenFromCloud ?? 0;
  const hasStatus = visibleCount !== undefined || withheld > 0 || onDeviceLocalOnly === true;

  return (
    <>
      <Button
        appearance="subtle"
        size={compact ? "medium" : "small"}
        className={compact ? styles.triggerCompact : styles.trigger}
        icon={local ? <IconShieldCheck /> : <IconGlobe />}
        onClick={() => setOpen(true)}
        aria-label={
          local
            ? "All local — nothing has left this machine this session"
            : `${label} — view egress detail`
        }
      >
        {/* §2: the badge text renders only where it fits; compact keeps the
            icon (shield = all local, globe = something left) and tells the
            full story in the dialog. */}
        {!compact && (
          <Badge appearance="tint" color={local ? "success" : "warning"}>
            {label}
          </Badge>
        )}
      </Button>

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <LhDialogSurface>
          <DialogBody>
            <DialogTitle>{hasStatus ? "Privacy status" : "What left this machine"}</DialogTitle>
            <DialogContent>
              {hasStatus && (
                <div className={styles.list}>
                  {visibleCount !== undefined && (
                    <div className={styles.row}>
                      <div className={styles.rowTop}>
                        <Text className={styles.host}>
                          {visibleCount} {visibleCount === 1 ? "file" : "files"} visible to AI
                        </Text>
                      </div>
                      <Text className={styles.sub}>
                        Answers draw only on these files. Toggle a file&apos;s eye in the
                        explorer to change the set.
                      </Text>
                    </div>
                  )}
                  {onDeviceLocalOnly && (
                    <div className={styles.row}>
                      <div className={styles.rowTop}>
                        <Text className={styles.host}>On-device</Text>
                      </div>
                      <Text className={styles.sub}>
                        This investigation always answers on this device.
                      </Text>
                    </div>
                  )}
                  {withheld > 0 && (
                    <div className={styles.row}>
                      <div className={styles.rowTop}>
                        <Text className={styles.host}>{hiddenFromCloudLabel(withheld)}</Text>
                      </div>
                      <Text className={styles.sub}>
                        Marked “Private — this device only”, so they are withheld from the
                        active cloud model. The private model can always read them.
                      </Text>
                      {onRevealHidden && (
                        <Button
                          size="small"
                          appearance="secondary"
                          className={styles.revealBtn}
                          icon={<IconLock />}
                          onClick={() => {
                            onRevealHidden();
                            setOpen(false);
                          }}
                        >
                          Show them in the file list
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {local ? (
                <div className={styles.allLocal}>
                  <IconShieldCheck />
                  <Text>
                    Nothing has left this machine this session. Retrieval, the
                    index, embeddings, OCR, and (with the private model) the AI
                    all run on your device.
                  </Text>
                </div>
              ) : (
                <>
                  <Text className={styles.sub}>
                    Destinations contacted this session — host, why, and how
                    many times. Never the content of any request.
                  </Text>
                  <div className={styles.list}>
                    {egress.destinations.map((d) => (
                      <div className={styles.row} key={`${d.host}\x00${d.purpose}`}>
                        <div className={styles.rowTop}>
                          <Text className={styles.host}>{d.host}</Text>
                          <Text className={styles.sub}>
                            {d.count} {d.count === 1 ? "request" : "requests"}
                          </Text>
                        </div>
                        <Text className={styles.sub}>
                          {d.purpose} · last {relTime(d.lastAt)}
                        </Text>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogActions>
          </DialogBody>
        </LhDialogSurface>
      </Dialog>
    </>
  );
}

/** The one-line summary for the widget pill footer (no dialog). */
export function egressPillSummary(
  egress: { total: number; destinations: { host: string }[] } | null,
): string | null {
  if (!egress) return null;
  if (egress.total === 0) return "All local";
  if (egress.destinations.length === 1) return `${egress.total} to ${egress.destinations[0].host}`;
  return `${egress.total} requests · ${egress.destinations.length} hosts`;
}
