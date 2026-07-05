"use client";

import { WidgetBar } from "@/features/widget/WidgetBar";

/**
 * The floating search-pill window (Tauri label "widget", route /widget —
 * static export emits a real second HTML entry the shell resolves). The root
 * layout's Providers already install the theme + IPC transport for every
 * route, and WidgetBar mounts its own vault/license state, so this page stays
 * a bare full-viewport mount. Nothing from app/page.tsx (launch ping, usage
 * publish, nudges, version badge) is imported: a second webview running those
 * would double-count telemetry (docs/widget-scope.md §2.4).
 */
export default function WidgetPage() {
  return <WidgetBar />;
}
