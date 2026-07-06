"use client";

/**
 * The install affordance shown next to the "Local model (private)" entry in the
 * model picker. The private model is a large (~4.2 GB) one-time download that we
 * don't bundle, so it's opt-in: a "＋" starts the download, a spinner shows
 * progress, and once present it reads "Installed" with an Uninstall control (to
 * free the space or re-test a fresh install). Rendered inside a Fluent `Option`,
 * so clicks on these controls must not also select the option.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  ProgressBar,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowDownloadRegular,
  CheckmarkCircleFilled,
  DeleteRegular,
} from "@fluentui/react-icons";

type ModelStatus = "ready" | "absent" | "downloading" | "uninstalling" | "error";

interface ModelState {
  status: ModelStatus;
  received: number;
  total: number;
  /** A `.gguf` leftover exists that can be removed even when it isn't a usable
   *  model (status "absent"/"error") — lets the user clear a stale/corrupt file. */
  removable?: boolean;
  /** Why the last install attempt failed (status "error"). */
  error?: string;
}

/** Poll the local-model status, exposing it plus `install()` / `uninstall()`. */
export function useLocalModel() {
  const [state, setState] = useState<ModelState>({ status: "absent", received: 0, total: 0 });
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/model");
      if (r.ok) setState(await r.json());
    } catch {
      /* transient - keep the last known state */
    }
  }, []);

  useEffect(() => {
    void poll();
    // Poll quickly while something is in flight, lazily otherwise.
    const inFlight = statusRef.current === "downloading" || statusRef.current === "uninstalling";
    const id = setInterval(() => void poll(), inFlight ? 1000 : 5000);
    return () => clearInterval(id);
  }, [poll, state.status]);

  const install = useCallback(async () => {
    setState((s) => ({ ...s, status: "downloading" })); // optimistic - instant feedback
    try {
      const r = await fetch("/api/model", { method: "POST" });
      if (r.ok) setState(await r.json());
    } catch {
      void poll();
    }
  }, [poll]);

  const uninstall = useCallback(async () => {
    setState((s) => ({ ...s, status: "uninstalling" })); // optimistic
    try {
      const r = await fetch("/api/model", { method: "DELETE" });
      if (r.ok) setState(await r.json());
    } catch {
      void poll();
    }
  }, [poll]);

  return { ...state, install, uninstall };
}

const useStyles = makeStyles({
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    width: "100%",
  },
  progress: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "nowrap",
  },
  installed: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorPaletteGreenForeground1,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "nowrap",
  },
  iconBtn: { minWidth: "auto", ...shorthands.padding("0", tokens.spacingHorizontalXS) },
  actions: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXXS },
  errorText: {
    color: tokens.colorStatusDangerForeground1,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "nowrap",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  panelHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  panelTitle: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  panelHint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  panelReady: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  panelProgressRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  // Ease the fill between the ~1s progress polls so it glides instead of
  // stepping (and looking stalled). Disabled under reduced motion.
  smoothBar: {
    "& [class*='fui-ProgressBar__bar']": {
      transitionProperty: "width",
      transitionDuration: "1s",
      transitionTimingFunction: "linear",
    },
    "@media (prefers-reduced-motion: reduce)": {
      "& [class*='fui-ProgressBar__bar']": { transitionDuration: "0.01ms" },
    },
  },
});

/** Human-readable size, e.g. "4.2 GB" / "512 MB". */
function humanBytes(n: number): string {
  if (!n) return "";
  const gb = n / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / 1_000_000)} MB`;
}

/** Transfer rate, e.g. "12.3 MB/s" / "640 KB/s". Empty when unknown. */
function humanRate(bps: number): string {
  if (!bps || bps <= 0) return "";
  const mb = bps / 1_000_000;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1000))} KB/s`;
}

/** Rough time-remaining, e.g. "~2 min left" / "~40 sec left". Empty when unknown. */
function humanEta(sec: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return `~${Math.max(1, Math.round(sec))} sec left`;
  return `~${Math.round(sec / 60)} min left`;
}

/**
 * A full-width, unmissable install panel for the private local model — shown in
 * the model picker (onboarding + the settings "AI models" dialog) whenever the
 * local provider is selected. This is the primary install affordance: the tiny
 * "＋" inside the dropdown option is easy to miss and unmounts when the dropdown
 * closes, so on its own a user couldn't tell whether the model installed. This
 * panel prompts the install, streams live download progress, and confirms
 * "Installed" — all in the panel body where it stays visible.
 */
export function LocalModelInstallPanel() {
  const styles = useStyles();
  const { status, received, total, removable, error, install, uninstall } = useLocalModel();
  const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : 0;

  // Derive transfer speed + ETA from successive progress samples (the state
  // itself only reports received/total). Smoothed with an EMA so the readout
  // doesn't jitter between polls; reset whenever a download isn't in flight.
  const [rate, setRate] = useState({ bps: 0, etaSec: 0 });
  const sample = useRef<{ received: number; t: number } | null>(null);
  useEffect(() => {
    if (status !== "downloading") {
      sample.current = null;
      setRate({ bps: 0, etaSec: 0 });
      return;
    }
    const now = Date.now();
    const prev = sample.current;
    sample.current = { received, t: now };
    if (prev && received > prev.received && now > prev.t) {
      const inst = ((received - prev.received) / (now - prev.t)) * 1000; // bytes/sec
      setRate((r) => {
        const bps = r.bps > 0 ? r.bps * 0.6 + inst * 0.4 : inst;
        const etaSec = total && bps > 0 ? (total - received) / bps : 0;
        return { bps, etaSec };
      });
    }
  }, [received, status, total]);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>
          {status === "ready" ? (
            <span className={styles.panelReady}>
              <CheckmarkCircleFilled fontSize={18} />
              Local model installed
            </span>
          ) : (
            <Text weight="semibold">On-device private model</Text>
          )}
        </span>

        {status === "ready" ? (
          <Tooltip
            content="Uninstall the private model (~4.2 GB) to free space or re-test the download"
            relationship="label"
          >
            <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => void uninstall()}>
              Uninstall
            </Button>
          </Tooltip>
        ) : status === "downloading" || status === "uninstalling" ? (
          <Spinner size="tiny" />
        ) : (
          <Button
            appearance="primary"
            size="small"
            icon={<ArrowDownloadRegular />}
            onClick={() => void install()}
          >
            {status === "error" ? "Retry install" : removable ? "Reinstall" : "Install"}
          </Button>
        )}
      </div>

      {status === "downloading" ? (
        <>
          <ProgressBar
            className={styles.smoothBar}
            value={total ? received / total : undefined}
            shape="rounded"
            thickness="large"
          />
          <div className={styles.panelProgressRow}>
            <span>Downloading the private model…</span>
            <span>
              {total ? `${pct}% · ${humanBytes(received)} / ${humanBytes(total)}` : humanBytes(received)}
              {rate.bps > 0 ? ` · ${humanRate(rate.bps)}` : ""}
              {rate.etaSec > 0 ? ` · ${humanEta(rate.etaSec)}` : ""}
            </span>
          </div>
        </>
      ) : status === "uninstalling" ? (
        <Text className={styles.panelHint}>Removing the private model…</Text>
      ) : status === "ready" ? (
        <Text className={styles.panelHint}>
          Answers are generated entirely on your machine — no API key, nothing leaves your computer.
        </Text>
      ) : status === "error" ? (
        <Text className={styles.errorText}>
          {error || "The download failed."} — check your connection and click Retry install.
        </Text>
      ) : (
        <Text className={styles.panelHint}>
          A one-time ~4.2 GB download runs the AI fully on your machine (no API key, fully private).
          Click Install to download it{removable ? " — this replaces an unusable leftover file" : ""}.
        </Text>
      )}
    </div>
  );
}

/** Option content for the local provider: label + its install state / controls. */
export function LocalModelOption({ label }: { label: string }) {
  const styles = useStyles();
  const { status, received, total, removable, error, install, uninstall } = useLocalModel();
  const pct = total ? Math.floor((received / total) * 100) : 0;

  // Clicks on these controls must not bubble up and select the option.
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation();

  /**
   * Fire an action from a button INSIDE a Fluent Option. The listbox closes -
   * and unmounts this row - on the option's mousedown, so a plain onClick never
   * fires (the button is gone before the click completes): the control reads as
   * dead. Trigger on mousedown instead, before the unmount; keep onClick for
   * keyboard activation. The server ops are idempotent, so if both ever fire
   * for one gesture the second is a no-op.
   */
  const act = (action: () => Promise<void>) => ({
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault(); // don't steal focus / trigger option selection
      swallow(e);
      void action();
    },
    onClick: (e: React.MouseEvent) => {
      swallow(e);
      void action();
    },
  });

  return (
    <span className={styles.row}>
      <span>{label}</span>
      {status === "ready" ? (
        <span className={styles.installed}>
          <CheckmarkCircleFilled fontSize={16} />
          Installed
          <Tooltip
            content="Uninstall the private model (~4.2 GB) to free space or re-test the download"
            relationship="label"
          >
            <Button
              className={styles.iconBtn}
              size="small"
              appearance="subtle"
              icon={<DeleteRegular />}
              aria-label="Uninstall the private model"
              {...act(uninstall)}
            />
          </Tooltip>
        </span>
      ) : status === "downloading" ? (
        <span className={styles.progress} aria-label={`Downloading private model, ${pct}%`}>
          <Spinner size="tiny" />
          {pct}%
        </span>
      ) : status === "uninstalling" ? (
        <span className={styles.progress} aria-label="Uninstalling private model">
          <Spinner size="tiny" />
          Removing…
        </span>
      ) : (
        <span className={styles.actions}>
          {/* A failed install must be VISIBLE, not tooltip-only - otherwise a
              click on ＋ that errors out reads as "the button does nothing". */}
          {status === "error" && (
            <Tooltip content={error || "The download failed."} relationship="description">
              <span className={styles.errorText}>install failed - retry</span>
            </Tooltip>
          )}
          {removable && (
            <Tooltip
              content="Remove the leftover model file — it isn't a usable model. Clears it so you can install a clean copy."
              relationship="label"
            >
              <Button
                className={styles.iconBtn}
                size="small"
                appearance="subtle"
                icon={<DeleteRegular />}
                aria-label="Remove the leftover model file"
                {...act(uninstall)}
              />
            </Tooltip>
          )}
          <Tooltip
            content={
              status === "error"
                ? "Install failed - click to retry (~4.2 GB, one time)"
                : removable
                  ? "Install a fresh copy of the private model (~4.2 GB, one time)."
                  : "Install the private model (~4.2 GB, one time). Runs fully on your machine."
            }
            relationship="label"
          >
            <Button
              className={styles.iconBtn}
              size="small"
              appearance="subtle"
              icon={<AddRegular />}
              aria-label="Install the private model"
              {...act(install)}
            />
          </Tooltip>
        </span>
      )}
    </span>
  );
}
