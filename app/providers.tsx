"use client";

import { useServerInsertedHTML } from "next/navigation";
import { useEffect, useState } from "react";
import {
  FluentProvider,
  RendererProvider,
  SSRProvider,
  createDOMRenderer,
  renderToStyleElements,
} from "@fluentui/react-components";
import { darkLighthouseTheme, lighthouseTheme } from "@/shell/theme";
import { useThemeStore } from "@/stores/useThemeStore";
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

  // Mirror the resolved theme onto <html> so surfaces Fluent doesn't own
  // follow along: globals.css keys the body off it, and `color-scheme` makes
  // native scrollbars and form controls render dark. layout.tsx only ships
  // the SSR default ("light"); this effect owns the attribute after mount.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  useServerInsertedHTML(() => {
    const styles = renderToStyleElements(renderer);
    return <>{styles}</>;
  });

  return (
    <RendererProvider renderer={renderer}>
      <SSRProvider>
        <FluentProvider theme={resolved === "dark" ? darkLighthouseTheme : lighthouseTheme}>
          {children}
        </FluentProvider>
      </SSRProvider>
    </RendererProvider>
  );
}
