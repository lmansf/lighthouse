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
  Spinner,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, CheckmarkCircleFilled, DeleteRegular } from "@fluentui/react-icons";

type ModelStatus = "ready" | "absent" | "downloading" | "uninstalling" | "error";

interface ModelState {
  status: ModelStatus;
  received: number;
  total: number;
  /** A `.gguf` leftover exists that can be removed even when it isn't a usable
   *  model (status "absent"/"error") — lets the user clear a stale/corrupt file. */
  removable?: boolean;
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
});

/** Option content for the local provider: label + its install state / controls. */
export function LocalModelOption({ label }: { label: string }) {
  const styles = useStyles();
  const { status, received, total, removable, install, uninstall } = useLocalModel();
  const pct = total ? Math.floor((received / total) * 100) : 0;

  // Clicks on these controls must not bubble up and select the option.
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation();

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
              onMouseDown={swallow}
              onClick={(e) => {
                swallow(e);
                void uninstall();
              }}
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
                onMouseDown={swallow}
                onClick={(e) => {
                  swallow(e);
                  void uninstall();
                }}
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
              onMouseDown={swallow}
              onClick={(e) => {
                swallow(e);
                void install();
              }}
            />
          </Tooltip>
        </span>
      )}
    </span>
  );
}
