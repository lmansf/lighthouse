#!/usr/bin/env node
/**
 * §31 §4: generate src/shell/icons.tsx — the single icon registry — from the
 * Framework7 Icons SVG set (MIT; an SF-flavored metaphor set that is safe to
 * vendor, unlike Apple's SF Symbols, which are licensed for Apple platforms
 * only and must NEVER be embedded).
 *
 * The MAPPING below is the curation: every Fluent glyph the app used, named
 * SEMANTICALLY and pointed at one Framework7 glyph. One stroke family, one
 * metaphor set; deliberate merges (edit/rename → pencil, the AI marks →
 * sparkles, folder open/closed → folder with the chevron carrying disclosure)
 * are the design language, not gaps — docs/design-language.md records them.
 *
 * Source of SVGs: node_modules/framework7-icons/svg (or F7_SVG_DIR env when
 * generating without an install). The output is COMMITTED — the build never
 * runs this; it exists so the registry is reproducible and auditable.
 * (scripts/gen-icons.mjs is the unrelated app-icon rasterizer.)
 *
 * Run: `node scripts/gen-glyphs.mjs` (fails listing any unmapped/missing glyph).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVG_DIR =
  process.env.F7_SVG_DIR || path.join(ROOT, "node_modules", "framework7-icons", "svg");

/** semantic export name → framework7 svg base name. */
const MAPPING = {
  // Chrome + navigation
  IconClose: "xmark",
  IconBack: "arrow_left",
  IconChevronLeft: "chevron_left",
  IconChevronRight: "chevron_right",
  IconChevronDown: "chevron_down",
  IconChevronUpDown: "chevron_up_chevron_down",
  IconSidebarExpand: "sidebar_left",
  IconSidebarCollapse: "sidebar_left",
  IconMore: "ellipsis",
  IconSearch: "search",
  IconWindow: "macwindow",
  IconDragHandle: "line_horizontal_3",
  // Tabs (rest + active pairs preserved for the tab bar)
  IconChat: "chat_bubble",
  IconChatFilled: "chat_bubble_fill",
  IconFolder: "folder",
  IconFolderFilled: "folder_fill",
  IconSettings: "gear_alt",
  IconSettingsFilled: "gear_alt_fill",
  // Files + vault
  IconFolderOpen: "folder",
  IconFolderAdd: "folder_badge_plus",
  IconMoveTo: "arrow_turn_up_right",
  IconDoc: "doc",
  IconDocText: "doc_text",
  IconDocPdf: "doc_richtext",
  IconDocAdd: "plus_rectangle",
  IconImage: "photo",
  IconTable: "table",
  IconDatabase: "tray_2",
  IconArchive: "archivebox",
  IconTag: "tag",
  IconLink: "link",
  IconAttach: "paperclip",
  IconSave: "tray_arrow_down",
  IconExport: "square_arrow_up",
  IconDownload: "arrow_down_to_line",
  IconCloudUp: "cloud_upload",
  // Privacy + trust
  IconLock: "lock",
  IconLockOpen: "lock_open",
  IconEye: "eye",
  IconEyeOff: "eye_slash",
  IconShield: "shield",
  IconShieldCheck: "checkmark_shield",
  IconShieldTask: "checkmark_shield",
  IconShieldKey: "lock_shield",
  IconGlobe: "globe",
  // Actions
  IconAdd: "plus",
  IconTrash: "trash",
  IconCheck: "checkmark_alt",
  IconCheckCircleFilled: "checkmark_alt_circle_fill",
  IconEdit: "pencil",
  IconRename: "pencil",
  IconCopy: "doc_on_doc",
  IconOpen: "arrow_up_right_square",
  IconSend: "paperplane",
  IconPin: "pin",
  IconPinFilled: "pin_fill",
  IconPlay: "play",
  IconPause: "pause",
  IconStop: "stop",
  IconUndo: "arrow_uturn_left",
  IconRefresh: "arrow_clockwise",
  IconSync: "arrow_2_circlepath",
  IconSort: "arrow_up_arrow_down",
  IconFilter: "line_horizontal_3_decrease",
  IconOptions: "slider_horizontal_3",
  IconArrowUp: "arrow_up",
  IconArrowDown: "arrow_down",
  IconBranch: "arrow_branch",
  // Status + messaging
  IconError: "exclamationmark_circle",
  IconWarning: "exclamationmark_triangle",
  IconInfo: "info_circle",
  IconHelp: "question_circle",
  IconHistory: "clock",
  IconMail: "envelope",
  IconThumbUp: "hand_thumbsup",
  IconThumbDown: "hand_thumbsdown",
  // Analytics + AI
  IconAI: "sparkles",
  IconSparkle: "sparkles",
  IconSparkleFilled: "sparkles",
  IconChatAI: "sparkles",
  IconSearchAI: "wand_stars",
  IconInsight: "lightbulb",
  IconChart: "chart_bar",
  IconBoard: "rectangle_grid_2x2",
  IconCode: "chevron_left_slash_chevron_right",
  IconBook: "book",
  IconLibrary: "bookmark",
  IconBriefcase: "briefcase",
  IconBeaker: "wand_rays",
  IconSquare: "stop",
};

const missing = [];
const entries = [];
const seenSvg = new Map();
for (const [name, svgName] of Object.entries(MAPPING)) {
  const file = path.join(SVG_DIR, `${svgName}.svg`);
  if (!existsSync(file)) {
    missing.push(`${name} -> ${svgName}.svg`);
    continue;
  }
  if (!seenSvg.has(svgName)) {
    const svg = readFileSync(file, "utf8");
    const paths = [...svg.matchAll(/<path\b([^>]*)>/g)].map((m) => {
      const attrs = m[1];
      const d = attrs.match(/\bd="([^"]+)"/)?.[1];
      const fr = attrs.match(/fill-rule="([^"]+)"/)?.[1];
      return d ? { d, fr } : null;
    }).filter(Boolean);
    if (paths.length === 0) {
      missing.push(`${name} -> ${svgName}.svg (no <path>)`);
      continue;
    }
    seenSvg.set(svgName, paths);
  }
  entries.push([name, svgName]);
}
if (missing.length) {
  console.error("Unresolvable glyphs:\n  " + missing.join("\n  "));
  process.exit(1);
}

const glyphConst = (svgName) =>
  "G_" + svgName.replace(/[^a-z0-9]+/gi, "_").toUpperCase();

let out = `"use client";

/* eslint-disable */
// GENERATED by scripts/gen-glyphs.mjs — edit the mapping there, not this file.
//
// §31 §4: THE icon registry. Every icon in the app imports from here —
// semantic names over one SF-flavored metaphor set. Glyph outlines are
// vendored from Framework7 Icons v5 (MIT, (c) Vladimir Kharlampidi;
// https://github.com/framework7io/framework7-icons — license text in the
// package). NO Apple SF Symbols or SF fonts are embedded anywhere in this
// repository (Apple-platform-only license); Framework7's set is the lawful
// SF-flavored stand-in, shipped to Windows/Linux too.
//
// Components render 1em square and inherit currentColor, so existing
// font-size/color styling keeps working. Active/rest pairs (...Filled) are
// preserved for the tab bar.

import * as React from "react";

// \`title\` renders an SVG <title> (the Fluent icons' tooltip/a11y affordance,
// kept so call sites migrate untouched); everything else spreads onto <svg>.
type IconProps = React.SVGProps<SVGSVGElement> & { title?: string };

type Glyph = { readonly d: string; readonly fr?: string };

function makeIcon(paths: readonly Glyph[]): React.FC<IconProps> {
  const Icon: React.FC<IconProps> = ({ title, ...props }) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 56 56"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {paths.map((p, i) => (
        <path key={i} d={p.d} fillRule={p.fr as never} />
      ))}
    </svg>
  );
  return Icon;
}

`;

for (const [svgName, paths] of seenSvg) {
  out += `const ${glyphConst(svgName)} = [\n${paths
    .map((p) => `  ${JSON.stringify(p)},`)
    .join("\n")}\n] as const;\n`;
}
out += "\n";
for (const [name, svgName] of entries) {
  out += `export const ${name} = makeIcon(${glyphConst(svgName)});\n`;
}

writeFileSync(path.join(ROOT, "src", "shell", "icons.tsx"), out);
console.log(
  `icons.tsx: ${entries.length} semantic names over ${seenSvg.size} glyphs (${Math.round(out.length / 1024)} KB)`,
);
