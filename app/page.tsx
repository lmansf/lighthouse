"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLicenseStore, isLocked } from "@/stores/useLicenseStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { LicenseGate, GraceBanner } from "@/features/license/LicenseGate";

/**
 * Composition root. The shell owns layout; each feature team replaces its own
 * placeholder component below without touching the others.
 *
 * Once onboarded, the license is checked once per launch. Nothing is ever
 * deleted: when the license isn't valid (trial used up, or a paid subscription
 * locked) the vault is greyed out and a sign-in / start-a-new-trial gate is
 * shown over it. A lapsed-but-in-grace paid license shows a renewal banner.
 */
export default function Home() {
  const step = useAuthStore((s) => s.onboarding.step);
  const onboarded = step === "done";

  const status = useLicenseStore((s) => s.status);
  const graceUntil = useLicenseStore((s) => s.graceUntil);
  const checkLicense = useLicenseStore((s) => s.check);

  useEffect(() => {
    if (onboarded) void checkLicense();
  }, [onboarded, checkLicense]);

  if (onboarded && isLocked(status)) {
    // Vault stays visible but greyed and non-interactive behind the gate.
    return (
      <>
        <div
          aria-hidden
          inert
          style={{
            position: "fixed",
            inset: 0,
            filter: "grayscale(1)",
            opacity: 0.4,
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          <AppShell rail={<ChatPanel />} content={<FileExplorer />} />
        </div>
        <LicenseGate status={status} />
      </>
    );
  }

  if (onboarded && status === "grace") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <GraceBanner graceUntil={graceUntil} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <AppShell rail={<ChatPanel />} content={<FileExplorer />} />
        </div>
      </div>
    );
  }

  return (
    <AppShell
      rail={onboarded ? <ChatPanel /> : <OnboardingPanel />}
      content={<FileExplorer />}
    />
  );
}
