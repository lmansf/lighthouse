#!/usr/bin/env node
/**
 * §39 §2: the seven-stamp lockstep tripwire. CLAUDE.md's release mechanics
 * require ALL SEVEN version stamps to move together; a partial bump ships a
 * release whose installers, updater manifests, and TestFlight builds disagree
 * about what version they are (the §33-era staleness class). This script
 * reads every stamp and exits non-zero — naming each offender — the moment
 * any of them drifts. Wired into the JS gate via test/checkStamps.test.mjs,
 * so the PR that causes drift goes red, not the release that inherits it.
 *
 * Run directly: node scripts/check-stamps.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

/** Collect every stamp as {label, value}; parsing failures surface as such. */
export function collectStamps() {
  const stamps = [];
  const push = (label, value) => stamps.push({ label, value: value ?? "<MISSING>" });

  push("package.json version", JSON.parse(read("package.json")).version);

  const lock = JSON.parse(read("package-lock.json"));
  push("package-lock.json root version", lock.version);
  push('package-lock.json packages[""] version', lock.packages?.[""]?.version);

  push(
    "native/Cargo.toml workspace version",
    read("native/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1],
  );

  push(
    "native/crates/lighthouse-desktop/tauri.conf.json version",
    JSON.parse(read("native/crates/lighthouse-desktop/tauri.conf.json")).version,
  );

  // Every lighthouse-* crate in the lockfile — by pattern, not count
  // (CLAUDE.md: the workspace grew past the original three).
  const cargoLock = read("native/Cargo.lock");
  for (const m of cargoLock.matchAll(/name = "(lighthouse-[a-z-]+)"\nversion = "([^"]+)"/g)) {
    push(`native/Cargo.lock ${m[1]}`, m[2]);
  }

  const projectYml = read("native/crates/lighthouse-desktop/gen/apple/project.yml");
  push(
    "gen/apple/project.yml CFBundleShortVersionString",
    projectYml.match(/CFBundleShortVersionString: (\S+)/)?.[1],
  );
  push(
    "gen/apple/project.yml CFBundleVersion",
    projectYml.match(/CFBundleVersion: "([^"]+)"/)?.[1],
  );

  const plist = read(
    "native/crates/lighthouse-desktop/gen/apple/lighthouse-desktop_iOS/Info.plist",
  );
  push(
    "gen/apple Info.plist CFBundleShortVersionString",
    plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
  );
  push(
    "gen/apple Info.plist CFBundleVersion",
    plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
  );

  return stamps;
}

export function checkStamps() {
  const stamps = collectStamps();
  const reference = stamps[0].value;
  const offenders = stamps.filter((s) => s.value !== reference);
  return { reference, stamps, offenders };
}

// CLI entry: report and exit. (Imported by test/checkStamps.test.mjs, which
// is how the tripwire rides the JS gate on every PR.)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { reference, stamps, offenders } = checkStamps();
  if (offenders.length === 0) {
    console.log(`✔ all ${stamps.length} version stamps agree: ${reference}`);
    process.exit(0);
  }
  console.error(`✘ version stamps DISAGREE (reference ${reference} from package.json):`);
  for (const o of offenders) {
    console.error(`  ${o.label}: ${o.value}`);
  }
  console.error(
    "All seven stamp files move together — see CLAUDE.md (release mechanics) " +
      "and docs/CONVENTIONS.md.",
  );
  process.exit(1);
}
