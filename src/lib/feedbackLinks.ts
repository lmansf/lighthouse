/**
 * Zero-backend feedback handoffs. The app itself transmits NOTHING: the feedback
 * dialog composes a report locally and hands it to the user's own mail client or
 * browser via these two URLs. Both builders are pure so a unit test can assert
 * the exact strings (see test/feedbackLinks.test.mjs).
 *
 * PRIVACY CONTRACT: only what the user typed, the app version, the OS, and — iff
 * they explicitly opt in — a shell.log excerpt they reviewed in full. Never a
 * file, file name, file content, account, or any identifier. Opening a mailto:
 * or a github.com issue URL is a navigation the user completes and sends
 * themselves; Lighthouse makes no network request of its own.
 */

/** Where "Email us" points. Shipped in the binary and asserted in the test. */
export const FEEDBACK_EMAIL = "lmansf96@gmail.com";
/** The public issue tracker "Open a GitHub issue" points at. */
export const FEEDBACK_ISSUES_URL = "https://github.com/lmansf/lighthouse/issues/new";

/** What the feedback is — a light triage signal chosen in the form. */
export type FeedbackKind = "idea" | "problem" | "praise";

/** Human label for a feedback kind (also the RadioGroup copy). */
export function feedbackKindLabel(kind: FeedbackKind): string {
  return kind === "problem" ? "Problem" : kind === "praise" ? "Praise" : "Idea";
}

export interface FeedbackReport {
  /** What kind of feedback this is (idea / problem / praise). Optional so the
   *  builders stay pure over a bare report; the form always sets it. */
  kind?: FeedbackKind;
  /** Optional "where in the app?" context. */
  where?: string;
  /** The required message (an idea, a problem, or a note of praise). */
  what: string;
  /** App version (e.g. "0.11.3"); client-side from NEXT_PUBLIC_APP_VERSION. */
  version?: string;
  /** Coarse OS label ("Windows" | "macOS" | "Linux"); client-side. */
  os?: string;
  /** Optional shell.log excerpt the user explicitly chose to include. */
  log?: string;
}

/**
 * A URL is a poor transport for a large log; mail clients and browsers cap the
 * length. We embed a bounded tail so the handoff never produces a pathological
 * URL — the dialog still renders the FULL excerpt for the user to read, and to
 * paste in themselves if they want everything.
 */
const LOG_URL_CAP = 3000;

/** The human-readable report body — shown for review AND used as the mail/issue body. */
export function composeFeedbackBody(r: FeedbackReport, opts: { capLog?: boolean } = {}): string {
  const lines: string[] = [];
  if (r.kind) {
    lines.push(`Kind: ${feedbackKindLabel(r.kind)}`, "");
  }
  lines.push(r.what.trim());
  if (r.where && r.where.trim()) {
    lines.push("", `Where: ${r.where.trim()}`);
  }
  const env = `Lighthouse ${r.version || "(unknown version)"} on ${r.os || "(unknown OS)"}`;
  lines.push("", `— ${env}`);
  if (r.log && r.log.trim()) {
    let log = r.log.trim();
    if (opts.capLog && log.length > LOG_URL_CAP) {
      log = `…(truncated)\n${log.slice(-LOG_URL_CAP)}`;
    }
    lines.push("", "Diagnostics (shell.log excerpt):", "```", log, "```");
  }
  return lines.join("\n");
}

/** A short subject/title derived from the message's first line. */
function feedbackSubject(r: FeedbackReport): string {
  const first = (r.what || "").trim().split("\n")[0].trim();
  const short = first.length > 72 ? `${first.slice(0, 69)}…` : first;
  return short ? `Lighthouse feedback: ${short}` : "Lighthouse feedback";
}

/** `mailto:` URL that opens the user's mail client with subject + body prefilled. */
export function buildFeedbackMailto(r: FeedbackReport): string {
  const subject = encodeURIComponent(feedbackSubject(r));
  const body = encodeURIComponent(composeFeedbackBody(r, { capLog: true }));
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
}

/**
 * A github.com "new issue" URL with title + body prefilled. Issues are PUBLIC;
 * the dialog says so before the user opens this. The `feedback` label is applied
 * when the repo has it (GitHub ignores unknown labels).
 */
export function buildFeedbackIssueUrl(r: FeedbackReport): string {
  const title = encodeURIComponent(feedbackSubject(r));
  const body = encodeURIComponent(composeFeedbackBody(r, { capLog: true }));
  return `${FEEDBACK_ISSUES_URL}?title=${title}&body=${body}&labels=feedback`;
}
