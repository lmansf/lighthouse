/** Local profile / onboarding endpoint (single-user standalone). */
import { NextResponse } from "next/server";
import {
  getState,
  signIn,
  register,
  selectModel,
  completeOnboarding,
  signOut,
} from "@/server/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getState());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "signIn":
      signIn(String(body.email ?? ""));
      break;
    case "register":
      register(String(body.name ?? ""), String(body.email ?? ""));
      break;
    case "selectModel":
      selectModel(String(body.providerId ?? ""), String(body.modelId ?? ""), String(body.apiKey ?? ""));
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
