"use client";

import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { ChatPanel } from "@/features/chat/ChatPanel";

/**
 * Composition root. The shell owns layout; each feature team replaces its own
 * placeholder component below without touching the others.
 */
export default function Home() {
  return (
    <AppShell
      rail={<OnboardingPanel />}
      explorer={<FileExplorer />}
      chat={<ChatPanel />}
    />
  );
}
