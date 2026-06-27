import { webDarkTheme, type Theme } from "@fluentui/react-components";

/**
 * RAG Vault theme. Starts from Microsoft's Fluent 2 dark theme and nudges it
 * toward a softer, more "organic" feel: warmer-tinted brand accent and larger
 * default corner radii used by the explorer's oversized file tiles.
 *
 * The shell team owns this file. Other features should consume Fluent `tokens`
 * rather than hardcoding colors, so this stays the single source of truth.
 */
export const ragVaultDarkTheme: Theme = {
  ...webDarkTheme,
  // Slightly larger radii than stock Fluent for the organic, rounded look.
  borderRadiusMedium: "8px",
  borderRadiusLarge: "12px",
  borderRadiusXLarge: "16px",
};

/** Layout constants shared across the shell. */
export const LAYOUT = {
  railWidth: 380,
  railCollapsedWidth: 64,
  headerHeight: 56,
} as const;
