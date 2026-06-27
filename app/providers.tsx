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

/**
 * Fluent UI v9 (Griffel) SSR wiring for the Next.js App Router.
 * Streams Griffel's collected styles into the document head so there is no
 * flash of unstyled content, and applies the Lighthouse (sandy-beach) theme.
 */
export function Providers({ children }: { children: React.ReactNode }) {
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
