"use client";

import dynamic from "next/dynamic";
import { useAuthStore } from "@/stores/useAuthStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { QuickStartAuto } from "@/features/help/QuickStart";
import { VersionBadge } from "@/shell/VersionBadge";

// These are pure overlays never on screen at first paint, and — unlike the
// mode-chooser/quick-start surfaces, whose modules are already pulled into the
// first-paint graph by the sidebar (SettingsMenu) and the chat/sidebar `modKey`
// imports — nothing else statically imports them, so deferring them here
// genuinely keeps their code out of the first-paint chunk.
const BugReport = dynamic(
  () => import("@/features/feedback/BugReport").then((m) => m.BugReport),
  { ssr: false },
);
const FeedbackNudge = dynamic(
  () => import("@/features/feedback/FeedbackNudge").then((m) => m.FeedbackNudge),
  { ssr: false },
);
const SummonHint = dynamic(
  () => import("@/features/widget/SummonHint").then((m) => m.SummonHint),
  { ssr: false },
);

/**
 * Composition root. The shell owns layout; each feature team replaces its own
 * placeholder component below without touching the others.
 */
export default function Home() {
  const step = useAuthStore((s) => s.onboarding.step);
  const onboarded = step === "done";

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
  } else {
    shell = <AppShell sidebar={<FileExplorer />} main={<ChatPanel />} />;
  }

  return (
    <>
      {shell}
      <BugReport />
      <VersionBadge />
      {onboarded && <FeedbackNudge />}
      {/* First-run surfaces: only once onboarding is done and the working shell
          is actually on screen. The window-vs-widget chooser is now an
          onboarding step (see OnboardingPanel), so by the time we're onboarded
          the interface mode is already settled and the tour can't stack behind
          it. */}
      {onboarded && (
        <>
          <QuickStartAuto />
          {/* First-run summon hint (desktop only, self-gated once-shown). */}
          <SummonHint />
        </>
      )}
    </>
  );
}
