// electron-builder `afterSign` hook: notarize the macOS app with Apple — but
// ONLY when the Apple credentials are present in the environment. Without them
// (an unsigned CI build, or any local build) it no-ops and returns, so it can
// never break a build that isn't being signed/notarized. Wired via
// package.json build.afterSign; activates once the APPLE_* secrets are set.
exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      "notarize: skipped — set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID to enable.",
    );
    return;
  }

  // Lazily require so an unsigned build never needs the module present.
  const { notarize } = require("@electron/notarize");
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;
  console.log(`notarize: submitting ${appPath} to Apple…`);
  await notarize({
    appBundleId: "com.lighthouse.app",
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log("notarize: done.");
};
