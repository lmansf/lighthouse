/** Local profile / onboarding endpoint (single-user standalone). */
import { NextResponse } from "next/server";
import {
  getState,
  finishVault,
  finishMode,
  selectModel,
  setDefaultInclusion,
  completeOnboarding,
  signOut,
  resolvedKeyFor,
} from "@/server/profile";
import { isSameOrigin } from "@/server/http";
import { providerAllowed } from "@/server/policy";
import { validateKey } from "@/server/llm";

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
    case "finishVault":
      finishVault();
      break;
    case "finishMode":
      finishMode();
      break;
    case "selectModel": {
      const providerId = String(body.providerId ?? "");
      // Managed policy: reject a disallowed provider with a real error
      // (selectModel itself also refuses to persist, belt-and-braces —
      // mirrors routes.rs/commands.rs).
      if (!providerAllowed(providerId)) {
        return NextResponse.json(
          { error: "this AI provider is managed off by your organization" },
          { status: 400 },
        );
      }
      selectModel(providerId, String(body.modelId ?? ""), String(body.apiKey ?? ""));
      break;
    }
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
    // Live "does this key work" probe. A blank key tests the one the chat
    // would actually use (stored or env). Returns {ok, error?}, NOT the
    // profile state — and never persists anything.
    case "validateKey": {
      const providerId = String(body.providerId ?? "");
      const pasted = String(body.apiKey ?? "").trim();
      const key = pasted || resolvedKeyFor(providerId) || "";
      return NextResponse.json(await validateKey(providerId, key));
    }
    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
  return NextResponse.json(getState());
}
