/**
 * §51: choice-density declutter across five surfaces. Pure UI — NO capability
 * removed (power actions relocate to overflow/advanced, always reachable), NO
 * engine/twin change, NO setting re-defaulted. These are source pins (the
 * surfaces are JSX the node runner can't mount); live behavior is the
 * simulator/E2E pass.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const chat = read("src/features/chat/ChatPanel.tsx");
const settings = read("src/features/settings/SettingsMenu.tsx");
const explorer = read("src/features/explorer/FileExplorer.tsx");
const investigations = read("src/features/investigations/InvestigationsNav.tsx");

test("§51 §1: the five 'do with it' actions live under ONE Save & share… menu, handlers intact", () => {
  // The five save/promote actions are built into one menu item list…
  for (const key of ['key: "csv"', 'key: "evidence"', 'key: "pin"', 'key: "view"', 'key: "metric"']) {
    assert.match(chat, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${key} in the Save & share menu`);
  }
  assert.match(chat, /Save &amp; share…/, "the pinned menu label");
  assert.match(chat, /aria-label="Save and share this answer"/, "the overflow menu is present");
  // …and every handler + gate is UNCHANGED (the moved controls keep their exact
  // behavior): the desktop-only ones stay handler-presence-gated, Define-metric
  // stays sqlHasAggregate-gated.
  assert.match(chat, /if \(onSave\)\s*\n?\s*shareItems\.push/, "Save-as-CSV still onSave-gated");
  assert.match(chat, /if \(onEvidencePack\)/, "Evidence pack still onEvidencePack-gated");
  assert.match(chat, /if \(onPin\)/, "Pin still onPin-gated");
  assert.match(chat, /if \(onDefineMetric && sqlHasAggregate\(meta\.sql\)\)/, "Define-metric still aggregate-gated");
  // The RefineChips call site still wires every handler — nothing was dropped.
  for (const prop of ["onSave={", "onEvidencePack={", "onPin={", "onSaveView={", "onDefineMetric={"]) {
    assert.ok(chat.includes(prop), `RefineChips still receives ${prop}`);
  }
});

test("§51 §1: feedback is ONE quiet Rate control, not two always-on thumbs", () => {
  // A single Rate menu expands to Good / Needs work, reusing rateAnswer.
  assert.match(chat, /aria-label="Rate this answer"/, "one Rate affordance");
  assert.match(chat, /label: "Good answer",\s*\n?\s*icon: <IconThumbUp \/>,\s*\n?\s*onClick: \(\) => rateAnswer\(m\.id, "up"\)/, "Good answer menu item → rateAnswer up");
  assert.match(chat, /label: "Needs work",\s*\n?\s*icon: <IconThumbDown \/>,\s*\n?\s*onClick: \(\) => rateAnswer\(m\.id, "down"\)/, "Needs work menu item → rateAnswer down");
  // The old two always-on thumb BUTTONS (aria-label Good/Bad answer) are gone —
  // the labels now live on menu items, not standalone buttons.
  assert.doesNotMatch(chat, /aria-label="Good answer"/, "no standalone Good-answer button");
  assert.doesNotMatch(chat, /aria-label="Bad answer"/, "no standalone Bad-answer button");
});

test("§51 §2: Preferences opens on two essentials with everything else under Advanced", () => {
  assert.match(settings, /const \[advancedOpen, setAdvancedOpen\] = useState\(false\)/, "Advanced is collapsed by default");
  // The essentials — Appearance + Text size — render BEFORE the Advanced toggle.
  const appearanceAt = settings.indexOf('<Field label="Appearance">');
  const textSizeAt = settings.indexOf('<Field label="Text size">');
  const toggleAt = settings.indexOf("onClick={() => setAdvancedOpen((o) => !o)}");
  const accentAt = settings.indexOf('<Field label="Accent">');
  assert.ok(appearanceAt > 0 && textSizeAt > 0 && toggleAt > 0 && accentAt > 0, "all anchors present");
  assert.ok(appearanceAt < textSizeAt && textSizeAt < toggleAt, "Appearance + Text size are the two essentials on top");
  assert.ok(toggleAt < accentAt, "accent (and the rest) live below the Advanced toggle");
  assert.match(settings, /\{advancedOpen && \(/, "the rest is gated behind the disclosure");
});

test("§51 §3: one direct + one bulk per privacy decision; no menu duplicates", () => {
  // The redundant row context-menu items are gone…
  assert.doesNotMatch(explorer, /\{node\.ragIncluded \? "Hide from AI" : "Visible to AI"\}/, "no Visible-to-AI menu item");
  assert.doesNotMatch(explorer, /"Allow cloud models" : "Keep private \(this device only\)"/, "no Keep-private menu item");
  // …but the INLINE controls (the direct entries) remain, wired to the same handlers.
  assert.match(explorer, /onClick=\{\(e\) => \{\s*\n\s*e\.stopPropagation\(\);\s*\n\s*toggleLocalOnly\(\);/, "inline lock still toggles local-only");
  assert.match(explorer, /onClick=\{\(e\) => \{\s*\n\s*e\.stopPropagation\(\);\s*\n\s*toggleVisibility\(\);/, "inline eye still toggles visibility");
  // The investigation control reads as a POLICY, not a per-file repeat.
  assert.match(investigations, /label="Investigation policy: answer only with the on-device model"/, "investigation policy relabel");
});

test("§51 §4: the Files toolbar folds Sort + the two filters into one View menu", () => {
  assert.match(explorer, /aria-label="View options — sort and filter"/, "one View control");
  assert.match(explorer, /<MenuItemCheckbox name="filters" value="visible"/, "Only-visible filter is a checkable menu item");
  assert.match(explorer, /<MenuItemCheckbox name="filters" value="localOnly"/, "Hidden-from-cloud filter is a checkable menu item");
  assert.match(explorer, /checked=\{onlyVisible \|\| onlyLocalOnly\}/, "the View button stays tinted while a filter is on");
  // The old standalone filter ToggleButtons are gone from the toolbar top level.
  assert.doesNotMatch(explorer, />\s*Only visible to AI\s*<\/ToggleButton>/, "no standalone Only-visible toggle");
  assert.doesNotMatch(explorer, />\s*Hidden from cloud\s*<\/ToggleButton>/, "no standalone Hidden-from-cloud toggle");
  // Sort options still live in the menu (Name/Size/Type), behavior unchanged.
  assert.match(explorer, /\(\["name", "size", "type"\] as const\)\.map/, "sort options preserved in the View menu");
});

test("§51 §5: New-chat + Add-files stay single-door per surface; events + shortcut intact", () => {
  // ONE visible New-chat per layout (compact icon vs desktop text — mutually
  // exclusive), plus the Mod+N shortcut and the window event as the seams.
  assert.match(chat, /aria-label="New chat"\s*\n\s*disabled=\{streaming\}\s*\n\s*onClick=\{newChat\}/, "compact New-chat icon");
  assert.match(chat, /onClick=\{newChat\}\s*\n\s*title=\{`Start a fresh conversation \(\$\{modKey\(\)\}\+N\)`\}/, "desktop New-chat + Mod+N hint");
  assert.match(chat, /window\.addEventListener\("lighthouse:new-chat", onNewChat\)/, "the new-chat event seam stays");
  assert.match(read("src/shell/AppShell.tsx"), /fire\("lighthouse:new-chat"\)/, "Mod+N still fires new-chat");
  // The chat's persistent add-to-vault door is the attach popover's item; the
  // browse-files event is the shared seam every add entry routes through.
  assert.match(chat, /Add files to vault…/, "the attach popover owns the chat's add-to-vault");
  assert.match(chat, /new CustomEvent\("lighthouse:browse-files"\)/, "add routes through the shared browse-files event");
});

test("§51 §6: stamps ride v0.14.16 — no bump (combined release, §48 set them)", () => {
  // The original §51 spec said bump+1, but the owner folded §49/§51/§52 into ONE
  // v0.14.16 release with §48 (no per-feature bump). Pin package.json here; the
  // release-mechanics stamp tripwire covers the other six.
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.version, "0.14.16", "package.json rides 0.14.16, unbumped");
});
