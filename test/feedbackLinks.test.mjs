// Zero-backend feedback handoffs (src/lib/feedbackLinks.ts). Proof gate (c):
// the "Send feedback" dialog transmits nothing — it hands the composed report to
// the user's own mail client or browser. These tests pin the exact mailto: and
// prefilled github.com issue URLs, so a regression that points feedback at a
// server (or the wrong address) fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  FEEDBACK_EMAIL,
  FEEDBACK_ISSUES_URL,
  composeFeedbackBody,
  buildFeedbackMailto,
  buildFeedbackIssueUrl,
} = await import("../src/lib/feedbackLinks.ts");

const report = {
  where: "Chat panel",
  what: "The chart axis labels overlap on small windows.",
  version: "0.11.3",
  os: "Windows",
};

test("Email us → a correct mailto: with subject + body prefilled, no server", () => {
  const url = buildFeedbackMailto(report);
  assert.ok(url.startsWith(`mailto:${FEEDBACK_EMAIL}?`), `unexpected scheme/address: ${url}`);
  assert.equal(FEEDBACK_EMAIL, "lmansf96@gmail.com");
  const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.match(q.get("subject") ?? "", /^Lighthouse feedback/);
  const body = q.get("body") ?? "";
  assert.ok(body.includes("chart axis labels overlap"), "message missing from body");
  assert.ok(body.includes("Where: Chat panel"), "where-context missing");
  assert.ok(body.includes("Lighthouse 0.11.3 on Windows"), "version/OS footer missing");
  // It is a navigation, not a fetch — no http(s) endpoint is embedded.
  assert.ok(!/https?:\/\//.test(url), "mailto must not contain an http endpoint");
});

test("Open a GitHub issue → a correct prefilled public issue URL", () => {
  const url = buildFeedbackIssueUrl(report);
  assert.ok(
    url.startsWith("https://github.com/lmansf/lighthouse/issues/new?"),
    `unexpected issue URL: ${url}`,
  );
  assert.ok(url.startsWith(`${FEEDBACK_ISSUES_URL}?`));
  const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.match(q.get("title") ?? "", /^Lighthouse feedback/);
  const body = q.get("body") ?? "";
  assert.ok(body.includes("chart axis labels overlap"), "message missing from issue body");
  assert.ok(body.includes("Lighthouse 0.11.3 on Windows"), "version/OS footer missing");
  assert.equal(q.get("labels"), "feedback");
});

test("an included shell.log excerpt rides along, capped so the URL stays sane", () => {
  const big = "x".repeat(9000);
  const body = composeFeedbackBody({ ...report, log: big }, { capLog: true });
  assert.ok(body.includes("Diagnostics (shell.log excerpt):"));
  assert.ok(body.includes("…(truncated)"), "an oversized log must be truncated in the handoff");
  // Full, uncapped body (what the dialog renders for review) keeps everything.
  const full = composeFeedbackBody({ ...report, log: big });
  assert.ok(full.includes(big), "review view must show the full excerpt");
});

test("no message → a bare subject, still a valid handoff", () => {
  const url = buildFeedbackMailto({ what: "" });
  const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.equal(q.get("subject"), "Lighthouse feedback");
});
