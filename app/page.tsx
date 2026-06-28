"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLicenseStore } from "@/stores/useLicenseStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { TrialExpired } from "@/features/license/TrialExpired";

/**
 * Composition root. The shell owns layout; each feature team replaces its own
 * placeholder component below without touching the others.
 *
 * The left rail hosts onboarding until the user is set up, then becomes the
 * Ask/chat panel. The file explorer fills the rest of the screen. Once
 * onboarded, the trial license is checked once per launch; an expired trial
 * (the vault is reset server-side) shows the "start a new trial" screen.
 */
export default function Home() {
  const step = useAuthStore((s) => s.onboarding.step);
  const onboarded = step === "done";

  const licenseStatus = useLicenseStore((s) => s.status);
  const checkLicense = useLicenseStore((s) => s.check);

  useEffect(() => {
    if (onboarded) void checkLicense();
  }, [onboarded, checkLicense]);

  if (onboarded && (licenseStatus === "expired" || licenseStatus === "none")) {
    return <TrialExpired status={licenseStatus} />;
  }

  return (
    <AppShell
      rail={onboarded ? <ChatPanel /> : <OnboardingPanel />}
      content={<FileExplorer />}
    />
  );
}
