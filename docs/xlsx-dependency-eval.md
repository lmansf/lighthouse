# Spreadsheet (.xlsx) parsing — dependency evaluation

**Status:** evaluation for the maintainer. Low urgency — the shipped product is
unaffected. Recommendation at the bottom.

## TL;DR

- The **shipped Rust engine already reads `.xlsx/.xlsm/.xls`** via the
  [`calamine`](https://crates.io/crates/calamine) crate (a normal, `cargo
  audit`-covered crates.io dependency). No action needed for the product.
- The **TypeScript dev twin** parses the same formats with **SheetJS
  (`xlsx` 0.20.3), fetched from `https://cdn.sheetjs.com/…`** — because SheetJS
  no longer publishes to the npm registry. This is a **dev/CI-only** dependency,
  but it has two supply-chain rough edges worth a maintainer decision.

## Why this needs a decision

`package.json` pins:

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

1. **`npm audit` can't see it.** A URL/tarball dependency isn't matched against
   the npm advisory database the way a registry package is, so the
   `supply-chain.yml` npm gate will **not** surface a future SheetJS advisory.
   (`package-lock.json` does pin the resolved URL **and** an integrity hash, so
   the artifact can't be swapped silently — availability, not integrity, is the
   gap.)
2. **The CDN is a single point of availability.** `npm ci` must reach
   `cdn.sheetjs.com`. In a locked-down / air-gapped CI or corporate proxy this
   fetch fails — which is exactly the failure this repo has hit. If the CDN is
   ever unreachable or the exact version URL is pulled, a clean install breaks.

Not at issue: the **community npm `xlsx` (last published 0.18.5)** is deprecated
and carries prototype-pollution + ReDoS advisories. Using SheetJS 0.20.3 from
the CDN is the *correct, patched* choice — the question is only how to **source**
it robustly.

## Options

| # | Option | Pros | Cons |
|---|---|---|---|
| A | **Keep the CDN URL** (status quo) | Zero work; latest patched SheetJS; lockfile integrity-pinned | `npm ci` depends on `cdn.sheetjs.com`; invisible to `npm audit` |
| B | **Vendor the tarball** into the repo (`vendor/xlsx-0.20.3.tgz`, install via `file:`) | Hermetic installs; no external fetch; integrity by git | Adds a ~7 MB binary blob to the repo; manual bumps |
| C | **Mirror to the project's own release assets** and install from there (reuse the `mirror-hf-assets.yml` pattern) | Hermetic; matches the existing model-asset mirror; no repo bloat | One-time CI wiring; still a manual bump |
| D | **Swap to a registry parser** — [`exceljs`](https://www.npmjs.com/package/exceljs) or [`node-xlsx`](https://www.npmjs.com/package/node-xlsx) | Back on npm → `npm audit`-covered | Behavior/format drift from `calamine` risks breaking PARITY with the Rust CSV output; re-validation cost |
| E | **Drop `.xlsx` from the twin** (return "unsupported" in dev) | Removes the dependency entirely | Parity gap: the twin can't preview a format the product supports; worse dev/test fidelity |

## Recommendation

**Option C (mirror to release assets), plus a fail-closed guard — but treat it
as low priority.** Rationale:

- The twin is a **development aid**, not shipped. Its spreadsheet fidelity
  matters for parity tests, not for users, so the bar is "hermetic and
  reproducible," not "audited like a shipped dep."
- C makes `npm ci` independent of an external CDN (the concrete failure we hit)
  while keeping the exact, correct SheetJS build and its PARITY-matched CSV
  output — no re-validation against `calamine`. It reuses machinery the repo
  already has (`mirror-hf-assets.yml`, `asset-digests.yml`).
- Avoid **D** unless the twin's xlsx path is causing real maintenance pain: a
  parser swap risks silent divergence from the Rust engine's cell formatting,
  which the `CACHE_VERSION`-gated parity relies on.

**Fail-closed scaffolding (do regardless of A–E):** guard the dynamic import so a
missing/unreachable `xlsx` module degrades to "unsupported format," never a crash
— mirroring how OCR is absent from the twin (PARITY). Today `extractXlsx` does a
bare `await import("xlsx")`; wrap it:

```ts
let XLSX: typeof import("xlsx");
try { XLSX = await import("xlsx"); }
catch { return ""; } // xlsx parser unavailable in this dev build — Rust ships calamine
```

## What the maintainer must provision (if adopting C)

1. Add SheetJS `xlsx-<version>.tgz` to the project's release-assets mirror (the
   same release the HF/model assets live on), SHA-256-recorded in
   `asset-digests.yml`.
2. Repoint `package.json` `"xlsx"` at that mirror URL and refresh
   `package-lock.json`.
3. Document the bump step alongside `scripts/fetch-local-model.mjs` so future
   SheetJS updates follow the mirror-first, hash-verified path.

Until then, **Option A stands** and is safe: the lockfile integrity hash means
the CDN can't feed a tampered artifact; only availability is unguaranteed, and
only for dev/CI installs.
