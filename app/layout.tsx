import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Lighthouse",
  description: "Curate which files and data sources your AI can see.",
};

// Touch app posture (owner directive): the screen is ZOOM-LOCKED on iPhone/iPad
// — no focus-zoom when the follow-up composer takes focus, and no pinch-zoom.
// iPad/iPhone are the design target, so type is sized to read at 1× rather than
// leaning on the user to zoom. viewport-fit=cover keeps env(safe-area-inset-*)
// so the frame clears the notch / home indicator. Desktop (mouse) ignores
// user-scalable, so this is a no-op there.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
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
