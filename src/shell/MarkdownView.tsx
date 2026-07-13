"use client";

/**
 * The react-markdown + remark-gfm stack, isolated behind one module so it can
 * be pulled in on demand with `next/dynamic` instead of shipping in the initial
 * chunk. The markdown renderer (~263 KB with micromark + mdast/hast) is only
 * needed once a chat answer with markdown is on screen — never for onboarding,
 * an empty chat, the license gate, or the widget's idle search bar — so both
 * ChatPanel and WidgetBar lazy-load this. Keeping remark-gfm imported *here*
 * (not at the call sites) is what actually moves the whole stack into the
 * split chunk.
 *
 * Callers pass their own `components` overrides (citation chips, chart fences,
 * copy-CSV tables) and any extra remark plugins (e.g. the citation splitter);
 * remark-gfm is always applied first so table/strikethrough parsing matches
 * what shipped before this was split out — the rendered output is unchanged.
 */

import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownViewProps {
  content: string;
  components?: Components;
  /** Extra remark plugins applied after remark-gfm (e.g. citation markers). */
  remarkPlugins?: Options["remarkPlugins"];
}

export default function MarkdownView({ content, components, remarkPlugins }: MarkdownViewProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
