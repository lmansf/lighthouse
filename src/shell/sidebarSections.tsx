"use client";

/**
 * Sectioned-sidebar registry (openspec: field-patch-0.12.5 §1). The Files tree
 * anchors the sidebar; these sections become header-only rows (the
 * SectionRail) that each slide out a second panel (the SectionFlyout) holding the
 * section's full, existing UI. This registry is the single source of truth for
 * the rows' identity, order, label, icon, and which component the flyout mounts —
 * so the rail and the flyout can never drift out of step.
 *
 * Order is top-to-bottom exactly as the spec pins it: history (§22.2 — recent
 * chats moved here from the ChatPanel header), then insights, semantic,
 * capabilities, recipes, library (the Views nav), investigations. Each label
 * matches the section's own `aria-label` so the rail row and the panel it opens
 * read identically.
 *
 * Beam treatment lives in the rail/flyout; here we only name a neutral Regular
 * icon per section. The components are untouched — they render the same in the
 * flyout as they did stacked in the old flat sidebar.
 */
import type { ComponentType } from "react";
import {
  HistoryRegular,
  LightbulbRegular,
  BookRegular,
  WandRegular,
  BeakerRegular,
  LibraryRegular,
  FolderSearchRegular,
  type FluentIcon,
} from "@fluentui/react-icons";
import { HistoryNav } from "@/features/chat/HistoryNav";
import { InsightsNav } from "@/features/insights/InsightsNav";
import { SemanticNav } from "@/features/semantic/SemanticNav";
import { CapabilityNav } from "@/features/capabilities/CapabilityNav";
import { RecipesNav } from "@/features/recipes/RecipesNav";
import { ViewsNav } from "@/features/views/ViewsNav";
import { InvestigationsNav } from "@/features/investigations/InvestigationsNav";

export interface SidebarSection {
  /** Stable id — the persisted `openFlyout` value and the rail↔flyout key. */
  id: string;
  /** Human label, matching the section component's own aria-label. */
  label: string;
  /** A neutral @fluentui/react-icons Regular glyph for the rail row. */
  icon: FluentIcon;
  /** The existing section component the flyout mounts, verbatim. */
  Component: ComponentType;
}

/**
 * The non-file sections, top-to-bottom. The order is asserted by the nav-UI
 * tests (they moved here from app/page.tsx when the tree became the anchor).
 * History leads (§22.2 — recent chats moved out of the ChatPanel header);
 * the original six keep their pinned relative order beneath it.
 */
export const SIDEBAR_SECTIONS: SidebarSection[] = [
  { id: "history", label: "History", icon: HistoryRegular, Component: HistoryNav },
  { id: "insights", label: "What stands out", icon: LightbulbRegular, Component: InsightsNav },
  { id: "semantic", label: "Business definitions", icon: BookRegular, Component: SemanticNav },
  { id: "capabilities", label: "What you can do", icon: WandRegular, Component: CapabilityNav },
  { id: "recipes", label: "Recipes", icon: BeakerRegular, Component: RecipesNav },
  { id: "library", label: "Library", icon: LibraryRegular, Component: ViewsNav },
  {
    id: "investigations",
    label: "Investigations",
    icon: FolderSearchRegular,
    Component: InvestigationsNav,
  },
];

/** Look up a section by id (null-safe) — the rail highlight + the flyout body
 *  both resolve the active section through this, so an unknown/stale persisted
 *  id simply resolves to null (no ghost flyout). */
export function sectionById(id: string | null): SidebarSection | null {
  if (!id) return null;
  return SIDEBAR_SECTIONS.find((s) => s.id === id) ?? null;
}
