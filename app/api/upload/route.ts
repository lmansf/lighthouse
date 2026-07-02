/** Upload endpoint: stream multipart files into the vault (excluded by default). */
import { NextResponse } from "next/server";
import { addFile } from "@/server/vault";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB per request (aggregate cap)

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

  // For folder uploads the client sends a `paths` entry per file (the file's
  // path relative to the dropped folder, e.g. "notes/2024/q1.md") so the folder
  // structure is recreated in the vault. Pair each file with its path *before*
  // dropping non-file entries, so a stray non-file `files` value can't shift the
  // index alignment of every file that follows it.
  const rawPaths = form.getAll("paths");
  const items = form
    .getAll("files")
    .map((entry, i) => ({
      file: entry,
      path: typeof rawPaths[i] === "string" ? (rawPaths[i] as string) : "",
    }))
    .filter((p): p is { file: File; path: string } => typeof p.file !== "string");

  const added: { newId: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let accepted = 0;
  let totalBytes = 0;
  for (const { file, path: rel } of items) {
    if (accepted >= MAX_FILES) {
      skipped.push({ name: file.name, reason: `exceeds max of ${MAX_FILES} files` });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ name: file.name, reason: `exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB limit` });
      continue;
    }
    // Bound total bytes read into memory per request, so a batch of many
    // under-limit files can't be used to exhaust memory.
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      skipped.push({ name: file.name, reason: `request exceeds ${MAX_TOTAL_BYTES / (1024 * 1024)}MB total` });
      continue;
    }
    // Derive a sub-directory from the relative path (everything but the file
    // name); fall back to the single `dir` field. addFile guards against escapes.
    const subDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null;
    const target = subDir || dest;
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      added.push(addFile(file.name, bytes, target));
      accepted++;
      totalBytes += file.size;
    } catch (err) {
      skipped.push({ name: file.name, reason: err instanceof Error ? err.message : "upload failed" });
    }
  }
  return NextResponse.json({ added, skipped });
}
