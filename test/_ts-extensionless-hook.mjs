/**
 * Resolve hook half of _ts-extensionless.mjs (see there).
 *
 * Handles the two specifier shapes the engine sources use that node's default
 * resolver does not:
 *
 *  1. TypeScript's extensionless RELATIVE imports (`./config` → `./config.ts`).
 *  2. The `@/*` path alias tsconfig maps to `./src/*`. Node knows nothing
 *     about tsconfig paths, so any module importing `@/lib/x` at RUNTIME was
 *     simply untestable here — which is exactly how src/lib/reportExport.ts
 *     ended up with no test of its own (its neighbour reportExport.test.mjs
 *     tests evidencePack instead) and scored 4.5% on the mutation harness.
 *     Resolving the alias closes that gap rather than working around it.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `@/lib/x` → an absolute file URL under src/, trying `.ts`/`.tsx` in turn. */
function aliasCandidates(specifier) {
  const rel = specifier.slice(2); // drop the leading "@/"
  const base = path.join(ROOT, "src", rel);
  return /\.[a-z]+$/i.test(rel)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    let lastErr;
    for (const candidate of aliasCandidates(specifier)) {
      try {
        return await next(pathToFileURL(candidate).href, context);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
  try {
    return await next(specifier, context);
  } catch (err) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    throw err;
  }
}
