"use client";

import dynamic from "next/dynamic";
import { useAuthStore } from "@/stores/useAuthStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileInspectorHost } from "@/features/chat/FileInspector";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { VersionBadge } from "@/shell/VersionBadge";

// These are pure overlays never on screen at first paint, and — unlike the
// mode-chooser surface, whose module is already pulled into the first-paint
// graph by the sidebar (SettingsMenu) and the chat/sidebar `modKey` imports —
// nothing else statically imports them, so deferring them here genuinely keeps
// their code out of the first-paint chunk. The first-run tour lives here too:
// it self-gates on the `tourShown` setting and only ever mounts in this MAIN
// window, so the widget (/widget) and explorer (/explorer) windows never run it.
const BugReport = dynamic(
  () => import("@/features/feedback/BugReport").then((m) => m.BugReport),
  { ssr: false },
);
const FeedbackNudge = dynamic(
  () => import("@/features/feedback/FeedbackNudge").then((m) => m.FeedbackNudge),
  { ssr: false },
);
const FirstRunTour = dynamic(
  () => import("@/features/help/FirstRunTour").then((m) => m.FirstRunTour),
  { ssr: false },
);
const ReportReaderHost = dynamic(
  () => import("@/features/chat/ReportReaderHost").then((m) => m.ReportReaderHost),
  { ssr: false },
);
const ReportsHomeHost = dynamic(
  () => import("@/features/chat/ReportsHome").then((m) => m.ReportsHomeHost),
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
    // dvh so onboarding isn't clipped under the mobile toolbar; 100vh fallback.
    height: "100vh",
    minHeight: "100dvh",
    alignItems: "center",
    justifyContent: "center",
    overflowX: "hidden",
    overflowY: "auto",
    // Clear notches / home indicator on the full-screen onboarding surface.
    padding:
      "var(--lh-safe-top) var(--lh-safe-right) var(--lh-safe-bottom) var(--lh-safe-left)",
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
    // 0.13.10 §3: the sidebar is Files + the Settings footer, nothing else —
    // the Files tree is the body's only content (no section rail).
    shell = (
      <AppShell main={<ChatPanel />} />
    );
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
          {/* First-run orientation tour: self-gated on `tourShown` (shown once
              per install), main window only, and re-runnable from the settings
              gear's "Take the tour". */}
          <FirstRunTour />
          {/* Citation → preview host: opens the file inspector on the cited
              chunk for chat citations. */}
          <FileInspectorHost />
          {/* §49 §2: the in-app report reader — opened by lighthouse:open-report
              {id} from every report door (generate, per-answer, Reports home).
              Mounted here (not lazily on open) so its listener persists while
              closed; reading a report is a local read, never egress. */}
          <ReportReaderHost />
          {/* §49 §4: the desktop Reports home dialog — opened by
              lighthouse:open-reports from the Sidebar footer. The compact shell
              shows the Reports PAGE (a tab) instead; this host is the desktop
              face of the same library. */}
          <ReportsHomeHost />
        </>
      )}
    </>
  );
}
