#!/usr/bin/env node
// TS-AST mutation harness for the Lighthouse TS engine.
//
// Standard Stryker-style operator set, applied one mutant at a time to a COPY
// of the repo (src/ + test/ + fixtures copied; node_modules symlinked), so
// parallel module runs can never contaminate each other. A mutant is KILLED
// when the paired test command exits non-zero (or times out at 3x baseline).
//
// Usage: node mutate.mjs --repo /home/user/lighthouse --sandbox /tmp/sb-views \
//          --target src/server/views.ts --tests test/views.test.mjs test/answerCache.test.mjs \
//          --out results.json [--max 400]
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, multi = false) => {
  const i = args.indexOf("--" + name);
  if (i < 0) return multi ? [] : undefined;
  if (!multi) return args[i + 1];
  const vals = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) vals.push(args[j]);
  return vals;
};
const REPO = opt("repo"), SANDBOX = opt("sandbox"), TARGET = opt("target");
const TESTS = opt("tests", true), OUT = opt("out");
const MAX = parseInt(opt("max") || "500", 10);

// ---- sandbox setup: copy everything except heavy/irrelevant dirs; link node_modules
if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
const SKIP = new Set(["node_modules", "native", ".git", ".next", "ui-dist", "archive"]);
for (const entry of readdirSync(REPO)) {
  if (SKIP.has(entry)) continue;
  const s = path.join(REPO, entry);
  cpSync(s, path.join(SANDBOX, entry), { recursive: true });
}
symlinkSync(path.join(REPO, "node_modules"), path.join(SANDBOX, "node_modules"));
// native/ is read by some source-pin tests: copy just the crates' src (small)
const natSrc = path.join(REPO, "native");
if (existsSync(natSrc)) {
  cpSync(natSrc, path.join(SANDBOX, "native"), {
    recursive: true,
    filter: (src) => !/native\/(target|gen)(\/|$)/.test(src.replace(/\\/g, "/")),
  });
}

const ts = (await import(path.join(REPO, "node_modules", "typescript", "lib", "typescript.js"))).default;

// ---- collect mutation sites
const targetAbs = path.join(SANDBOX, TARGET);
const original = readFileSync(targetAbs, "utf8");
const sf = ts.createSourceFile(TARGET, original, ts.ScriptTarget.ES2022, true,
  TARGET.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const BIN_SWAPS = new Map([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
  [ts.SyntaxKind.EqualsEqualsToken, "!="], [ts.SyntaxKind.ExclamationEqualsToken, "=="],
  [ts.SyntaxKind.LessThanToken, "<="], [ts.SyntaxKind.LessThanEqualsToken, "<"],
  [ts.SyntaxKind.GreaterThanToken, ">="], [ts.SyntaxKind.GreaterThanEqualsToken, ">"],
  [ts.SyntaxKind.AmpersandAmpersandToken, "||"], [ts.SyntaxKind.BarBarToken, "&&"],
  [ts.SyntaxKind.PlusToken, "-"], [ts.SyntaxKind.MinusToken, "+"],
  [ts.SyntaxKind.AsteriskToken, "/"], [ts.SyntaxKind.SlashToken, "*"],
  [ts.SyntaxKind.PercentToken, "*"],
]);

const sites = [];
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
function visit(node) {
  if (ts.isBinaryExpression(node)) {
    const k = node.operatorToken.kind;
    if (BIN_SWAPS.has(k)) {
      // skip string concatenation for +/- (mutating "a"+"b" to "a"-"b" = NaN, trivially caught but noisy)
      const isPlus = k === ts.SyntaxKind.PlusToken;
      const looksString = isPlus && [node.left, node.right].some(
        (s) => ts.isStringLiteralLike(s) || ts.isTemplateExpression(s));
      if (!looksString)
        sites.push({ op: "binop", start: node.operatorToken.getStart(sf), end: node.operatorToken.getEnd(),
          from: node.operatorToken.getText(sf), to: BIN_SWAPS.get(k), line: lineOf(node.operatorToken.getStart(sf)) });
    }
  } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    const to = node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true";
    sites.push({ op: "bool", start: node.getStart(sf), end: node.getEnd(), from: node.getText(sf), to, line: lineOf(node.getStart(sf)) });
  } else if (ts.isNumericLiteral(node)) {
    const v = node.getText(sf);
    const to = v === "0" ? "1" : v === "1" ? "0" : String(Number(v) + 1);
    if (to !== v && !Number.isNaN(Number(to)))
      sites.push({ op: "num", start: node.getStart(sf), end: node.getEnd(), from: v, to, line: lineOf(node.getStart(sf)) });
  } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    // remove negation: !x -> x
    sites.push({ op: "negation-removal", start: node.getStart(sf), end: node.operand.getStart(sf), from: "!", to: "", line: lineOf(node.getStart(sf)) });
  } else if (ts.isIfStatement(node)) {
    // condition negation: if (c) -> if (!(c))
    const c = node.expression;
    sites.push({ op: "if-negate", start: c.getStart(sf), end: c.getEnd(),
      from: c.getText(sf).slice(0, 40), to: "!(" + c.getText(sf) + ")", line: lineOf(c.getStart(sf)), rawTo: true });
  }
  ts.forEachChild(node, visit);
}
visit(sf);

// dedupe by (start,end,to) and sort; cap deterministically by even sampling if over MAX
const seen = new Set();
let mutants = sites.filter((s) => {
  const key = `${s.start}:${s.end}:${s.to}`;
  if (seen.has(key)) return false;
  seen.add(key); return true;
}).sort((a, b) => a.start - b.start);
const totalSites = mutants.length;
if (mutants.length > MAX) {
  const step = mutants.length / MAX;
  mutants = Array.from({ length: MAX }, (_, i) => mutants[Math.floor(i * step)]);
}

// ---- baseline
const runTests = (timeoutMs) => spawnSync("node", ["--test", ...TESTS], {
  cwd: SANDBOX, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const t0 = Date.now();
const base = runTests(240_000);
const baselineMs = Date.now() - t0;
if (base.status !== 0) {
  console.error("BASELINE RED — refusing to mutate. stderr tail:\n" + (base.stderr || "").slice(-2000));
  process.exit(2);
}
const budget = Math.max(10_000, baselineMs * 3);

// ---- mutate loop
const results = [];
let killed = 0, survived = 0, timeouts = 0;
for (const [i, m] of mutants.entries()) {
  const mutated = original.slice(0, m.start) + (m.rawTo ? m.to : m.to) + original.slice(m.end);
  writeFileSync(targetAbs, mutated);
  const r = runTests(budget);
  writeFileSync(targetAbs, original);
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  const outcome = timedOut ? "timeout" : r.status === 0 ? "survived" : "killed";
  if (outcome === "killed") killed++; else if (outcome === "survived") survived++; else timeouts++;
  results.push({ line: m.line, op: m.op, from: m.from, to: m.to.slice(0, 40), outcome });
  if ((i + 1) % 25 === 0)
    console.error(`[${TARGET}] ${i + 1}/${mutants.length} killed=${killed} survived=${survived} to=${timeouts}`);
}
const tested = killed + survived + timeouts;
const score = tested ? ((killed + timeouts) / tested) * 100 : 0;
const summary = { target: TARGET, tests: TESTS, totalSites, tested, killed, survived, timeouts,
  score: Math.round(score * 10) / 10, baselineMs, survivors: results.filter((r) => r.outcome === "survived") };
writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary.survivors.length > 25
  ? { ...summary, survivors: summary.survivors.slice(0, 25).concat([{ note: `+${summary.survivors.length - 25} more` }]) }
  : summary, null, 2));
