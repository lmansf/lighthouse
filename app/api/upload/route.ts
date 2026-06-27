/** Upload endpoint: stream multipart files into the vault (excluded by default). */
import { NextResponse } from "next/server";
import { addFile } from "@/server/vault";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const destRaw = form.get("dir");
  const dest = typeof destRaw === "string" && destRaw ? destRaw : null;

  const added: { newId: string }[] = [];
  const skipped: string[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string") continue;
    const file = entry as File;
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      added.push(addFile(file.name, bytes, dest));
    } catch {
      skipped.push(file.name);
    }
  }
  return NextResponse.json({ added, skipped });
}
