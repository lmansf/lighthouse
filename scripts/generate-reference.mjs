import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "docs", "reference");
const roots = ["app", "src", "native/crates", "scripts"];
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".rs"]);
const skipped = new Set(["node_modules", "target", ".next", "release", "gen"]);

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return skipped.has(entry.name) ? [] : filesUnder(full);
      return extensions.has(path.extname(entry.name)) ? [full] : [];
    }),
  );
  return nested.flat();
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function typescriptFunctions(source) {
  return [
    ...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm),
    ...source.matchAll(
      /^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/gm,
    ),
  ]
    .map((match) => match[1])
    .sort();
}

function rustFunctions(source) {
  return [...source.matchAll(/^pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)/gm)]
    .map((match) => match[1])
    .sort();
}

function rustMethods(source) {
  const methods = [];
  let owner = null;
  let depth = 0;
  for (const line of source.split("\n")) {
    const impl = line.match(/^impl(?:<[^>]+>)?\s+([\w:]+).*\{/);
    if (impl) {
      owner = impl[1];
      depth = 0;
    }
    if (owner) {
      const method = line.match(/^\s+pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)/);
      if (method) methods.push(`${owner}::${method[1]}`);
      depth += [...line].filter((c) => c === "{").length;
      depth -= [...line].filter((c) => c === "}").length;
      if (depth <= 0) owner = null;
    }
  }
  return methods.sort();
}

function words(name) {
  return name
    .replaceAll("::", " ")
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function plainPurpose(name) {
  const label = words(name.split("::").at(-1));
  if (label === "get") return "Lets one part of the app ask another part for information.";
  if (label === "post") return "Lets one part of the app send information to another part.";
  if (label === "delete") return "Asks for something to be removed safely.";
  const starts = [
    ["get ", "Gets something the app needs."],
    ["list ", "Makes a list so people can see what is there."],
    ["read ", "Reads saved information."],
    ["write ", "Saves information safely."],
    ["set ", "Changes one saved choice."],
    ["create ", "Makes something new."],
    ["add ", "Puts something into the right place."],
    ["remove ", "Takes something away safely."],
    ["delete ", "Removes something that is no longer wanted."],
    ["update ", "Brings saved information up to date."],
    ["build ", "Puts pieces together to make something useful."],
    ["check ", "Looks carefully for a problem."],
    ["validate ", "Checks that something is safe and makes sense."],
    ["parse ", "Turns writing into pieces the app can understand."],
    ["render ", "Draws information so a person can see it."],
    ["find ", "Looks for the right thing."],
    ["search ", "Looks through the saved things for a match."],
    ["open ", "Opens something for the person using the app."],
    ["close ", "Closes something when it is finished."],
    ["move ", "Puts something in a new place."],
    ["rename ", "Gives something a new name."],
    ["restore ", "Brings back something that was removed."],
    ["export ", "Makes a copy that can be shared or saved elsewhere."],
    ["is ", "Answers a yes-or-no question."],
    ["has ", "Checks whether something is there."],
    ["can ", "Checks whether something is allowed or possible."],
    ["new", "Makes a fresh helper that is ready to use."],
    ["start", "Begins a job."],
    ["finish", "Finishes a job and tidies up."],
    ["run", "Does the job this helper was made for."],
    ["push", "Adds the next small piece to a growing group."],
    ["record", "Writes down what happened so it is not forgotten."],
    ["stop", "Stops a job before it goes too far."],
    ["id", "Gives the short name used to find something again."],
    ["window", "Chooses how much space is available for work."],
  ];
  return starts.find(([start]) => label.startsWith(start))?.[1] ?? "Helps the app do its job.";
}

function section(file, names) {
  if (names.length === 0) return "";
  return `## \`${file}\`\n\n${names.map((name) => `- \`${name}\` - ${plainPurpose(name)}`).join("\n")}\n\n`;
}

async function inventory() {
  const files = (await Promise.all(roots.map((dir) => filesUnder(path.join(root, dir))))).flat();
  const functions = [];
  const methods = [];
  for (const file of files.sort()) {
    const source = await readFile(file, "utf8");
    const name = relative(file);
    const exported = file.endsWith(".rs") ? rustFunctions(source) : typescriptFunctions(source);
    functions.push(section(name, exported));
    if (file.endsWith(".rs")) methods.push(section(name, rustMethods(source)));
  }
  return { functions: functions.join(""), methods: methods.join("") };
}

function page(title, intro, inventoryText) {
  return `<!-- Generated by scripts/generate-reference.mjs. Do not edit manually. -->\n\n# ${title}\n\n${intro}\n\n${inventoryText.trimEnd()}\n`;
}

const { functions, methods } = await inventory();
const pages = new Map([
  ["functions.md", page("Function reference", "This page is a big list of the jobs the code can do.\n\nEach line has the code name first and then a short, simple clue about what that job helps the app do.\n\nThe jobs are grouped by file because a file is like one drawer that keeps similar jobs together.", functions)],
  ["methods.md", page("Method reference", "This page lists jobs that belong to a particular kind of thing in the Rust engine.\n\nEach line has the code name first and then a short, simple clue about what that job helps with.\n\nKeeping a job next to the thing it works on helps programmers avoid mixing up important information.", methods)],
]);

await mkdir(outputDir, { recursive: true });
for (const [name, content] of pages) {
  const target = path.join(outputDir, name);
  if (process.argv.includes("--check")) {
    const current = await readFile(target, "utf8").catch(() => "");
    if (current !== content) {
      console.error(`${relative(target)} is stale. Run node scripts/generate-reference.mjs.`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(target, content);
  }
}
