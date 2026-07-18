"use client";

import { useServerInsertedHTML } from "next/navigation";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  FluentProvider,
  RendererProvider,
  SSRProvider,
  createDOMRenderer,
  renderToStyleElements,
} from "@fluentui/react-components";
import { themeFor } from "@/shell/theme";
import { useThemeStore } from "@/stores/useThemeStore";
import { useAppearanceStore } from "@/stores/useAppearanceStore";
import { installTauriTransport } from "@/shell/tauriTransport";

/**
 * Fluent UI v9 (Griffel) SSR wiring for the Next.js App Router.
 * Streams Griffel's collected styles into the document head so there is no
 * flash of unstyled content, and applies the light or dark Lighthouse theme
 * from the theme store (user preference, "system" following the OS).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // Inside the Tauri shell, /api/* calls ride IPC (there is no local HTTP
  // server there); a no-op everywhere else. Installed before any feature
  // component mounts so no call can slip through.
  useState(() => installTauriTransport());
  const [renderer] = useState(() => createDOMRenderer());
  const resolved = useThemeStore((s) => s.resolved);
  // Appearance customization (openspec §3): accent + density + font scale ride
  // the resolved mode into themeFor, which returns an AA-validated Fluent theme.
  const accent = useAppearanceStore((s) => s.accent);
  const density = useAppearanceStore((s) => s.density);
  const fontScale = useAppearanceStore((s) => s.fontScale);

  // Mirror the resolved theme onto <html> so surfaces Fluent doesn't own
  // follow along: globals.css keys the body off it, and `color-scheme` makes
  // native scrollbars and form controls render dark. layout.tsx only ships
  // the SSR default ("light"); this effect owns the attribute after mount.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  // React flushes inserted-HTML several times per page during the static
  // export, and `renderToStyleElements` re-serializes Griffel's ENTIRE
  // accumulated stylesheet on every call — not just the delta. Left as-is that
  // stamps the same ~11 style blocks into <head> a dozen times each (measured:
  // 121 tags, only 11 distinct, ~327 KB of pure duplicate CSS in index.html
  // alone), all parsed into the CSSOM before first paint. Track the exact CSS
  // we've already emitted and drop any block whose contents we've seen, so each
  // distinct stylesheet block is written exactly once. Deduping on content (not
  // bucket key) can never drop a rule — every distinct block is still emitted —
  // so the app stays fully styled.
  const emittedCss = useRef<Set<string>>(new Set());
  useServerInsertedHTML(() => {
    const elements = renderToStyleElements(renderer) as ReactElement<{
      dangerouslySetInnerHTML?: { __html?: string };
    }>[];
    const fresh = elements.filter((el) => {
      // Fall back to the element key for any block without inline CSS (has no
      // rules to duplicate); dedupe real stylesheets by their exact contents.
      const sig = el.props?.dangerouslySetInnerHTML?.__html ?? String(el.key ?? "");
      if (emittedCss.current.has(sig)) return false;
      emittedCss.current.add(sig);
      return true;
    });
    return fresh.length > 0 ? <>{fresh}</> : null;
  });

  return (
    <RendererProvider renderer={renderer}>
      <SSRProvider>
        <FluentProvider theme={themeFor(resolved, accent, density, fontScale)}>
          {children}
        </FluentProvider>
      </SSRProvider>
    </RendererProvider>
  );
}
