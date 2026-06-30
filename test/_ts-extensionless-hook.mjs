/** Resolve hook half of _ts-extensionless.mjs (see there). */
export async function resolve(specifier, context, next) {
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
