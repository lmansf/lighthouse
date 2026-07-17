"use client";

import dynamic from "next/dynamic";
import { useAuthStore } from "@/stores/useAuthStore";
import { AppShell } from "@/shell/AppShell";
import { OnboardingPanel } from "@/features/onboarding/OnboardingPanel";
import { FileExplorer } from "@/features/explorer/FileExplorer";
// Static import (no dynamic gain): FileExplorer already pulls FileInspector
// into the first-paint graph, so the host adds only its own few lines.
import { FileInspectorHost } from "@/features/explorer/FileInspector";
import { InvestigationsNav } from "@/features/investigations/InvestigationsNav";
import { ViewsNav } from "@/features/views/ViewsNav";
import { RecipesNav } from "@/features/recipes/RecipesNav";
import { SemanticNav } from "@/features/semantic/SemanticNav";
import { InsightsNav } from "@/features/insights/InsightsNav";
import { CapabilityNav } from "@/features/capabilities/CapabilityNav";
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
const SummonHint = dynamic(
  () => import("@/features/widget/SummonHint").then((m) => m.SummonHint),
  { ssr: false },
);
const FirstRunTour = dynamic(
  () => import("@/features/help/FirstRunTour").then((m) => m.FirstRunTour),
  { ssr: false },
);
const QuickOpen = dynamic(
  () => import("@/features/quickopen/QuickOpen").then((m) => m.QuickOpen),
  { ssr: false },
);
const BoardHost = dynamic(
  () => import("@/features/boards/BoardPanel").then((m) => m.BoardHost),
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
    // Investigations mount ABOVE the file tree as a sidebar fragment
    // (openspec: add-investigations design) — no Sidebar API change.
    shell = (
      <AppShell
        sidebar={
          <>
            {/* Proactive "What stands out" panel (openspec: add-quant-depth §5):
                the one surface that shows a finding WITHOUT the user asking, so
                it sits at the TOP of the analytics nav group. Placed above
                SemanticNav — the RecipesNav→ViewsNav→InvestigationsNav→
                FileExplorer adjacencies the nav-UI tests pin stay intact. */}
            <InsightsNav />
            <SemanticNav />
            {/* Capability map (openspec: add-deep-analysis §4.3): a "what can I
                do with this vault" overview + the Investigate affordance. Placed
                between SemanticNav and RecipesNav so the InsightsNav→SemanticNav
                and RecipesNav→ViewsNav→InvestigationsNav→FileExplorer adjacencies
                the nav-UI tests pin all stay intact. */}
            <CapabilityNav />
            <RecipesNav />
            <ViewsNav />
            <InvestigationsNav />
            <FileExplorer />
          </>
        }
        main={<ChatPanel />}
      />
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
          {/* First-run summon hint (desktop only, self-gated once-shown). */}
          <SummonHint />
          {/* Citation → preview host: opens the file inspector on the cited
              chunk for chat citations and the widget's cross-window handoff. */}
          <FileInspectorHost />
          {/* Ctrl/Cmd+P quick-open palette (time-savers): fuzzy-find a vault
              file, then reveal it in the explorer or attach it to the chat.
              Main window only — AppShell owns the shortcut. */}
          <QuickOpen />
          {/* The pin board (openspec: add-boards): opened from the settings
              gear via lighthouse:open-board; mounted here (not lazily on
              open) so its pins-changed listener retains change badges while
              the board is closed. */}
          <BoardHost />
        </>
      )}
    </>
  );
}
