import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Lighthouse",
  description: "Curate which files and data sources your AI can see.",
};

// viewport-fit=cover unlocks env(safe-area-inset-*) so the frame can clear the
// iPad home indicator / notches. No maximum-scale / user-scalable=no — pinch
// zoom stays available for accessibility. Desktop is unaffected.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // data-theme here is only the SSR default; Providers re-syncs it (and
    // color-scheme) to the resolved theme from the theme store after mount.
    <html lang="en" data-theme="light">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
