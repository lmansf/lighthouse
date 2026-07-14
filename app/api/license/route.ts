/** License endpoint: check, start a trial, activate a key, submit feedback,
 *  report a bug, and read feedback diagnostics. */
import { NextResponse } from "next/server";
import {
  checkLicense,
  startTrial,
  activateLicense,
  submitFeedback,
  submitFeatureInterest,
  submitNotify,
  submitBug,
  feedbackDiagnostics,
  checkoutUrl,
  paidEnabled,
  type FeedbackInput,
} from "@/server/license";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "config":
      return NextResponse.json({ paidEnabled: paidEnabled() });

    case "check":
      return NextResponse.json(await checkLicense());

    case "start": {
      // One-click new trial — reuses the saved contact identity, if any.
      try {
        await startTrial();
        return NextResponse.json({ ok: true });
      } catch (err) {
        return NextResponse.json(
          { ok: false, reason: "rejected", detail: err instanceof Error ? err.message : "start failed" },
          { status: 200 },
        );
      }
    }

    case "activate": {
      // Paste a purchased license key. Validated server-side; never destructive.
      const key = typeof body.licenseKey === "string" ? body.licenseKey : "";
      const result = await activateLicense(key);
      const ok = result.status === "valid" || result.status === "grace";
      return NextResponse.json({ ok, ...result });
    }

    case "feedback": {
      // Submit the feedback form. Linked to the signed-in account server-side
      // (contact id + the account's email), so the form no longer collects one.
      const f = body.feedback as Partial<FeedbackInput> | undefined;
      if (!f) {
        return NextResponse.json({ ok: false, reason: "rejected", detail: "feedback required" }, { status: 400 });
      }
      const result = await submitFeedback({
        firstName: String(f.firstName ?? "").trim(),
        lastName: String(f.lastName ?? "").trim(),
        easeOfUse: Number(f.easeOfUse ?? 0),
        overallValue: Number(f.overallValue ?? 0),
        liked: String(f.liked ?? "").trim(),
        changeOrAdd: String(f.changeOrAdd ?? "").trim(),
        notifyWhenAvailable: Boolean(f.notifyWhenAvailable),
      });
      return NextResponse.json(result);
    }

    case "notify": {
      // "Notify me when purchasing opens" (pre-launch interest capture).
      const email = typeof body.email === "string" ? body.email : "";
      if (!email.trim()) {
        return NextResponse.json({ ok: false, reason: "rejected", detail: "email required" }, { status: 400 });
      }
      return NextResponse.json(await submitNotify(email));
    }

    case "featureInterest": {
      // Which shelved features the user would use. `shown` = all offered ids,
      // `wanted` = the ones they'd use (⊆ shown). Stored in its own table.
      const shown = Array.isArray(body.shown) ? body.shown.map(String) : [];
      const wanted = Array.isArray(body.wanted) ? body.wanted.map(String) : [];
      return NextResponse.json(await submitFeatureInterest(shown, wanted));
    }

    case "diagnostics":
      // What the feedback dialog discloses before a Send (version, OS, log).
      return NextResponse.json(feedbackDiagnostics());

    case "bug": {
      const where = String(body.where ?? "").trim();
      const what = String(body.what ?? "").trim();
      if (!where && !what) {
        return NextResponse.json({ ok: false, reason: "rejected", detail: "empty report" }, { status: 400 });
      }
      // Attach the diagnostics excerpt only when the user ticked the box.
      const log = body.includeLog ? feedbackDiagnostics().log : undefined;
      return NextResponse.json(await submitBug(where, what, log));
    }

    case "checkout": {
      // Build the Stripe Payment Link URL (carries guid + email). Null if unset.
      const email = typeof body.email === "string" ? body.email : undefined;
      const url = await checkoutUrl(email);
      return NextResponse.json({ url });
    }

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
