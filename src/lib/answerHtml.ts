// Sanitization schema for inline HTML in rendered answers (MarkdownView).
//
// Answers render through react-markdown, which escapes raw HTML by default —
// so a model that emitted `<b>` or `<br>` showed literal tags. MarkdownView
// now parses raw HTML (rehype-raw) and immediately sanitizes the whole tree
// (rehype-sanitize) with THIS schema. Sanitizing the tree covers both the
// model's inline HTML and everything markdown itself produced — one allowlist
// guards the entire rendered answer.
//
// The schema is GitHub's battle-tested default with two deliberate edits:
//
// 1. NO remote-loading elements. `img`/`picture`/`source` are REMOVED even
//    though GitHub allows them: an answer's `<img src>` would make the webview
//    fetch an arbitrary URL the moment it renders — silent network egress from
//    model output (or from prompt-injected document content), invisible to the
//    egress ledger and the audit log. Nothing in an answer may cause a network
//    request; text formatting only.
// 2. `<style>` joins `<script>` in `strip` (content dropped, not unwrapped),
//    plus a few safe presentational tags GitHub omits (`mark`, `u`, `small`,
//    `abbr`, `time`, `wbr`, `figure`/`figcaption`, `caption`, `cite`, `dfn`).
//
// What the default already guarantees (verified in test/answerHtml.test.mjs):
// event handlers and unknown attributes stripped; `javascript:` and other
// non-allowlisted URL schemes neutralized; ids clobbered with a
// `user-content-` prefix so answer HTML can't shadow app anchors; `<code>`
// keeps only `language-*` classes — which is exactly what the chart/stat/SQL
// fence renderers key on — and citation links (`#lh-cite-n`) pass as relative
// hrefs. Tauri's CSP is the second wall; this schema is the first.
import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

/** Elements whose whole point is loading a remote resource — never in answers. */
const REMOTE_LOADING_TAGS = new Set(["img", "picture", "source"]);

export const ANSWER_HTML_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []).filter((t) => !REMOTE_LOADING_TAGS.has(t)),
    "abbr",
    "caption",
    "cite",
    "dfn",
    "figcaption",
    "figure",
    "mark",
    "small",
    "time",
    "u",
    "wbr",
  ],
  // Drop <style> bodies like <script> bodies — unwrapping would print CSS text.
  strip: [...(defaultSchema.strip ?? []), "style"],
};
