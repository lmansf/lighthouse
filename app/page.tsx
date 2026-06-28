"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLicenseStore, isLocked } from "@/stores/useLicenseStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { LicenseGate, GraceBanner, PostPurchaseFeedback } from "@/features/license/LicenseGate";
import { BugReport } from "@/features/feedback/BugReport";

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

  const status = useLicenseStore((s) => s.status);
  const graceUntil = useLicenseStore((s) => s.graceUntil);
  const pendingFeedback = useLicenseStore((s) => s.pendingFeedback);
  const checkLicense = useLicenseStore((s) => s.check);
  const loadConfig = useLicenseStore((s) => s.loadConfig);

  // Log the launch once on mount (best-effort) and load config (paid toggle),
  // independent of license/onboarding state so the nav reflects it at all times.
  useEffect(() => {
    void loadConfig();
    void fetch("/api/license", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "ping" }),
    }).catch(() => {});
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

  let shell: React.ReactNode;
  if (onboarded && isLocked(status)) {
    // Vault stays visible but greyed/inert; the rail hosts the lock gate.
    shell = (
      <AppShell
        rail={<LicenseGate status={status} />}
        content={
          <div aria-hidden inert style={greyed}>
            <FileExplorer />
          </div>
        }
      />
    );
  } else if (onboarded && pendingFeedback) {
    // Just subscribed: show the post-purchase survey in the rail (after Stripe's
    // receipt, before chat reopens). The vault is unlocked behind it.
    shell = <AppShell rail={<PostPurchaseFeedback />} content={<FileExplorer />} />;
  } else if (onboarded && status === "grace") {
    shell = (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <GraceBanner graceUntil={graceUntil} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <AppShell rail={<ChatPanel />} content={<FileExplorer />} />
        </div>
      </div>
    );
  } else {
    shell = (
      <AppShell
        rail={onboarded ? <ChatPanel /> : <OnboardingPanel />}
        content={<FileExplorer />}
      />
    );
  }

  return (
    <>
      {shell}
      <BugReport />
    </>
  );
}
