"use client";

import { useAuthStore } from "@/stores/useAuthStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { ChatPanel } from "@/features/chat/ChatPanel";

/**
 * Composition root. The shell owns layout; each feature team replaces its own
 * placeholder component below without touching the others.
 *
 * The left rail hosts onboarding until the user is set up, then becomes the
 * Ask/chat panel. The file explorer fills the rest of the screen.
 */
export default function Home() {
  const step = useAuthStore((s) => s.onboarding.step);
  const onboarded = step === "done";

  return (
    <AppShell
      rail={onboarded ? <ChatPanel /> : <OnboardingPanel />}
      content={<FileExplorer />}
    />
  );
}
