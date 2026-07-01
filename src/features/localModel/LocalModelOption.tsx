"use client";

/**
 * The install affordance shown next to the "Local model (private)" entry in the
 * model picker. The private model is a large (~4.2 GB) one-time download that we
 * don't bundle, so it's opt-in: a "＋" starts the download, a spinner shows
 * progress, and a check marks it installed. Rendered inside a Fluent `Option`,
 * so clicks on the button must not also select the option.
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
import { AddRegular, CheckmarkCircleFilled } from "@fluentui/react-icons";

interface ModelState {
  status: "ready" | "absent" | "downloading" | "error";
  received: number;
  total: number;
}

/** Poll the local-model status, exposing it plus an `install()` trigger. */
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
    // Poll quickly while a download is in flight, lazily otherwise.
    const id = setInterval(() => void poll(), statusRef.current === "downloading" ? 1000 : 5000);
    return () => clearInterval(id);
  }, [poll, state.status]);

  const install = useCallback(async () => {
    try {
      const r = await fetch("/api/model", { method: "POST" });
      if (r.ok) setState(await r.json());
    } catch {
      /* the next poll will reflect reality */
    }
  }, []);

  return { ...state, install };
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
  addBtn: { minWidth: "auto", ...shorthands.padding("0", tokens.spacingHorizontalXS) },
});

/** Option content for the local provider: label + its install state / trigger. */
export function LocalModelOption({ label }: { label: string }) {
  const styles = useStyles();
  const { status, received, total, install } = useLocalModel();
  const pct = total ? Math.floor((received / total) * 100) : 0;

  // A click on the install button must not bubble up and select the option.
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <span className={styles.row}>
      <span>{label}</span>
      {status === "ready" ? (
        <span className={styles.installed}>
          <CheckmarkCircleFilled fontSize={16} />
          Installed
        </span>
      ) : status === "downloading" ? (
        <span className={styles.progress} aria-label={`Downloading private model, ${pct}%`}>
          <Spinner size="tiny" />
          {pct}%
        </span>
      ) : (
        <Tooltip
          content={
            status === "error"
              ? "Install failed - click to retry (~4.2 GB, one time)"
              : "Install the private model (~4.2 GB, one time). Runs fully on your machine."
          }
          relationship="label"
        >
          <Button
            className={styles.addBtn}
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
      )}
    </span>
  );
}
