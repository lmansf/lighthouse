"use client";

import { useServerInsertedHTML } from "next/navigation";
import { useState } from "react";
import {
  FluentProvider,
  RendererProvider,
  SSRProvider,
  createDOMRenderer,
  renderToStyleElements,
} from "@fluentui/react-components";
import { lighthouseTheme } from "@/shell/theme";
import { installTauriTransport } from "@/shell/tauriTransport";

/**
 * Fluent UI v9 (Griffel) SSR wiring for the Next.js App Router.
 * Streams Griffel's collected styles into the document head so there is no
 * flash of unstyled content, and applies the Lighthouse (sandy-beach) theme.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // Inside the Tauri shell, /api/* calls ride IPC (there is no local HTTP
  // server there); a no-op everywhere else. Installed before any feature
  // component mounts so no call can slip through.
  useState(() => installTauriTransport());
  const [renderer] = useState(() => createDOMRenderer());

  useServerInsertedHTML(() => {
    const styles = renderToStyleElements(renderer);
    return <>{styles}</>;
  });

  return (
    <RendererProvider renderer={renderer}>
      <SSRProvider>
        <FluentProvider theme={lighthouseTheme}>{children}</FluentProvider>
      </SSRProvider>
    </RendererProvider>
  );
}
