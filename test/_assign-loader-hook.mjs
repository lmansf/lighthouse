/**
 * Resolve hook used by experiment.assign.test.mjs.
 *
 * Two jobs:
 *  1. Redirect the Edge Function's `https://esm.sh/@supabase/supabase-js@2`
 *     import to the in-memory mock so the real index.ts can run under Node.
 *  2. Retry an extensionless `./x` import as `./x.ts` (the server TS modules use
 *     TypeScript's extensionless relative imports), same as _ts-extensionless-hook.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const MOCK = pathToFileURL(path.join(import.meta.dirname, "_mock-supabase.mjs")).href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("https://esm.sh/@supabase/supabase-js")) {
    return { url: MOCK, shortCircuit: true };
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
