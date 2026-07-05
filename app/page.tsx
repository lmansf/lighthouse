"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLicenseStore, isLocked } from "@/stores/useLicenseStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { ModeChooserAuto } from "@/features/onboarding/ModeChooser";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { LicenseGate, GraceBanner, PostPurchaseFeedback } from "@/features/license/LicenseGate";
import { BugReport } from "@/features/feedback/BugReport";
import { FeedbackNudge } from "@/features/feedback/FeedbackNudge";
import { QuickStartAuto } from "@/features/help/QuickStart";
import { VersionBadge } from "@/shell/VersionBadge";

/**
 * Composition root. The shell owns layout; each feature team replaces its own
 * placeholder component below without touching the others.
 *
 * Once onboarded, the license is checked once per launch (and the launch is
 * logged). Nothing is ever deleted: when the license isn't valid the vault is
 * greyed out in the main pane and the left rail shows the lock gate — a feedback
 * form (after a trial) then a subscribe / start-a-trial choice. A lapsed paid
 * subscription still in grace shows a renewal banner.
 */
export default function Home() {
  const step = useAuthStore((s) => s.onboarding.step);
  const onboarded = step === "done";

  // First-run interface choice (window vs widget): the quick-start tour holds
  // until the chooser has settled — shown and answered, or skipped — so the
  // two dialogs never stack.
  const [modeSettled, setModeSettled] = useState(false);

  const status = useLicenseStore((s) => s.status);
  const graceUntil = useLicenseStore((s) => s.graceUntil);
  const pendingFeedback = useLicenseStore((s) => s.pendingFeedback);
  const checkLicense = useLicenseStore((s) => s.check);
  const loadConfig = useLicenseStore((s) => s.loadConfig);

  // Log the launch once on mount (best-effort) and load config (paid toggle),
  // independent of license/onboarding state so the nav reflects it at all times.
  // After the launch ping, publish any buffered UI usage events and purge them.
  useEffect(() => {
    void loadConfig();
    void (async () => {
      try {
        await fetch("/api/license", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "ping" }),
        });
      } catch {
        /* best-effort */
      }
      try {
        await fetch("/api/usage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "publish" }),
        });
      } catch {
        /* best-effort — buffered events stay for the next launch */
      }
    })();
  }, [loadConfig]);

  useEffect(() => {
    if (onboarded) void checkLicense();
  }, [onboarded, checkLicense]);

  const greyed: React.CSSProperties = {
    filter: "grayscale(1)",
    opacity: 0.45,
    pointerEvents: "none",
    height: "100%",
  };

  const centered: React.CSSProperties = {
    display: "flex",
    height: "100vh",
    alignItems: "center",
    justifyContent: "center",
    overflowY: "auto",
  };

  let shell: React.ReactNode;
  if (!onboarded) {
    // Onboarding takes the whole screen, centered — no sidebar/chat yet.
    shell = (
      <div style={centered}>
        <OnboardingPanel />
      </div>
    );
  } else if (isLocked(status)) {
    // Chat is replaced by the lock gate; the file sidebar stays visible but
    // greyed/inert so the workspace is recognizable behind the gate.
    shell = (
      <AppShell
        sidebar={
          <div aria-hidden inert style={greyed}>
            <FileExplorer />
          </div>
        }
        main={<LicenseGate status={status} />}
      />
    );
  } else if (pendingFeedback) {
    // Just subscribed: the post-purchase survey takes the main area before chat
    // reopens. The vault is unlocked in the sidebar.
    shell = <AppShell sidebar={<FileExplorer />} main={<PostPurchaseFeedback />} />;
  } else if (status === "grace") {
    shell = (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <GraceBanner graceUntil={graceUntil} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <AppShell sidebar={<FileExplorer />} main={<ChatPanel />} />
        </div>
      </div>
    );
  } else {
    shell = <AppShell sidebar={<FileExplorer />} main={<ChatPanel />} />;
  }

  return (
    <>
      {shell}
      <BugReport />
      <VersionBadge />
      {onboarded && <FeedbackNudge />}
      {/* First-run surfaces: only once the working shell is actually on screen
          (onboarded and the license check has RESOLVED unlocked) — mounting
          during the transient "unknown" status would flash them over a lock
          gate and burn the tour's once-per-install flag before it was seen.
          The mode chooser (desktop: window vs widget) goes first; the tour
          waits for it to settle so the two dialogs never stack. */}
      {onboarded && (status === "valid" || status === "grace" || status === "disabled") && (
        <>
          <ModeChooserAuto onSettled={() => setModeSettled(true)} />
          {modeSettled && <QuickStartAuto />}
        </>
      )}
    </>
  );
}
