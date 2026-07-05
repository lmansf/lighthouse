/** Local profile / onboarding endpoint (single-user standalone). */
import { NextResponse } from "next/server";
import {
  getState,
  signIn,
  register,
  finishRegistration,
  selectModel,
  setDefaultInclusion,
  completeOnboarding,
  signOut,
} from "@/server/profile";
import { isSameOrigin } from "@/server/http";
import { recordEvent } from "@/server/license";
import type { ModelSelectionResult } from "@/server/profile";

/**
 * Track which models people use: emit a `model_selected` event for the initial
 * choice and any later change. Skips no-op re-saves and any empty selection.
 * Non-PII app config; follows the same funnel-event path as first_query.
 */
function emitModelSelected(sel: ModelSelectionResult | null): void {
  if (!sel || (!sel.initial && !sel.changed) || !sel.provider || !sel.model) return;
  void recordEvent("model_selected", {
    provider: sel.provider,
    model: sel.model,
    initial: sel.initial,
    previous_provider: sel.previousProvider,
    previous_model: sel.previousModel,
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getState());
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "signIn":
      signIn(String(body.email ?? ""));
      break;
    case "register":
      register(String(body.name ?? ""), String(body.email ?? ""));
      break;
    case "finishRegistration":
      emitModelSelected(finishRegistration());
      break;
    case "selectModel":
      emitModelSelected(
        selectModel(
          String(body.providerId ?? ""),
          String(body.modelId ?? ""),
          String(body.apiKey ?? ""),
        ),
      );
      break;
    case "setDefaultInclusion":
      if (body.value !== "include" && body.value !== "exclude") {
        return NextResponse.json({ error: "value must be include or exclude" }, { status: 400 });
      }
      setDefaultInclusion(body.value);
      break;
    case "completeOnboarding":
      completeOnboarding();
      break;
    case "signOut":
      signOut();
      break;
    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
  return NextResponse.json(getState());
}
