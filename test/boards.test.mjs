// Boards TS twin (src/server/boards.ts) — mirrors the Rust integration
// tests (tests/boards_test.rs) so the two engines stay byte-compatible:
// round trip with order and sizes, unknown-version/corrupt bak-on-write,
// card-removal-preserves-pin, per-scope name collisions, lazy virtual
// defaults materializing under their deterministic ids, the card-parse
// validation table (errors byte-identical), and the twin's refreshCards
// posture — stored pin state, live: false (PARITY: analytics is Rust-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const boards = await import("../src/server/boards.ts");
const inv = await import("../src/server/investigations.ts");
const pinsMod = await import("../src/server/pins.ts");

/** Fresh vault per test — stateDir() re-reads VAULT_DIR on every call. */
function freshVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-boards-"));
  process.env.VAULT_DIR = dir;
  return path.join(dir, ".rag-vault");
}

function bakFiles(stateDir) {
  return fs
    .readdirSync(stateDir)
    .filter((n) => n.startsWith("boards.json.bak-"))
    .map((n) => path.join(stateDir, n));
}

test("round trip is byte-stable with order and sizes preserved", () => {
  const stateDir = freshVault();
  const created = boards.createBoard("Ops overview");
  assert.ok(created.id.startsWith("board-"), created.id);
  assert.equal(created.investigationId, undefined);
  assert.deepEqual(created.cards, []);

  // Three cards S, M, L, then reordered (one op for reorder/resize/add/
  // remove alike — an atomic full-list replace).
  boards.setBoardCards(created.id, [
    { pinId: "pin-aaa", size: "S" },
    { pinId: "pin-bbb", size: "M" },
    { pinId: "pin-ccc", size: "L" },
  ]);
  const reordered = [
    { pinId: "pin-ccc", size: "L" },
    { pinId: "pin-aaa", size: "S" },
    { pinId: "pin-bbb", size: "M" },
  ];
  boards.setBoardCards(created.id, reordered);

  // Re-read from disk: exact order and sizes preserved.
  const listed = boards.listBoardRecords();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].name, "Ops overview");
  assert.equal(listed[0].createdMs, created.createdMs);
  assert.deepEqual(listed[0].cards, reordered, "order and sizes round-trip exactly");

  // The on-disk envelope is the byte contract with the Rust engine: v1,
  // then the records, camelCase keys in declaration order, 2-space pretty,
  // sizes as bare "S"/"M"/"L" strings, investigationId omitted (global).
  const raw = fs.readFileSync(path.join(stateDir, "boards.json"), "utf8");
  assert.ok(raw.startsWith('{\n  "v": 1,\n  "boards": ['), raw);
  for (const [a, b] of [
    ['"id"', '"name"'],
    ['"name"', '"cards"'],
    ['"cards"', '"createdMs"'],
    ['"pinId"', '"size"'],
  ]) {
    assert.ok(raw.indexOf(a) !== -1 && raw.indexOf(a) < raw.indexOf(b), `${a} precedes ${b}`);
  }
  assert.ok(!raw.includes('"investigationId"'), `global boards omit the scope: ${raw}`);
  assert.ok(raw.includes('"size": "L"'), raw);

  // A scoped board carries its investigationId on disk.
  const harbor = inv.createInvestigation("Q3 audit", [], "default");
  boards.createBoard("Q3 numbers", harbor.id);
  const raw2 = fs.readFileSync(path.join(stateDir, "boards.json"), "utf8");
  assert.ok(raw2.includes(`"investigationId": "${harbor.id}"`), raw2);

  // Rename keeps the id; blank scope normalizes to global on create.
  const renamed = boards.renameBoard(created.id, "Ops, renamed");
  assert.equal(renamed.id, created.id, "rename keeps the id");
  assert.equal(boards.listBoardRecords()[0].name, "Ops, renamed");
  const blank = boards.createBoard("Blank scope", "  ");
  assert.equal(blank.investigationId, undefined, "blank scope = global");
});

test("unknown envelope version loads empty and baks on write", () => {
  const stateDir = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });
  const newer = '{"v":99,"boards":[{"id":"board-from-the-future"}]}';
  fs.writeFileSync(path.join(stateDir, "boards.json"), newer);

  // Session reads empty — never a crash, never a partial parse. The
  // listing still serves the virtual global default (lazy, not stored).
  assert.deepEqual(boards.listBoardRecords(), [], "v99 loads empty");
  const listing = boards.listBoards();
  assert.equal(listing.length, 1);
  assert.equal(listing[0].id, "default-global");

  // The first write preserves the unreadable file, then writes fresh v1.
  boards.createBoard("Fresh");
  const baks = bakFiles(stateDir);
  assert.equal(baks.length, 1, `exactly one bak: ${baks}`);
  assert.equal(fs.readFileSync(baks[0], "utf8"), newer, "newer data recoverable byte-for-byte");
  const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "boards.json"), "utf8"));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.boards[0].name, "Fresh");
  assert.equal(boards.listBoardRecords().length, 1);
});

test("corrupt json loads empty and baks on write", () => {
  const stateDir = freshVault();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "boards.json"), "{ not json");

  assert.deepEqual(boards.listBoardRecords(), [], "corrupt loads empty");
  boards.createBoard("After corruption");
  const baks = bakFiles(stateDir);
  assert.equal(baks.length, 1, `corrupt file preserved: ${baks}`);
  assert.equal(fs.readFileSync(baks[0], "utf8"), "{ not json");
  assert.equal(boards.listBoardRecords().length, 1);
});

test("card removal never touches the pin", () => {
  const stateDir = freshVault();

  // A real pin on disk, with stored recheck state as the desktop engine
  // would leave it (the twin shares the pins.json shape byte-compatibly).
  pinsMod.addPin("open tickets by priority", "SELECT 1", ["tickets.csv"]);
  const pinsPath = path.join(stateDir, "pins.json");
  const store = JSON.parse(fs.readFileSync(pinsPath, "utf8"));
  store.pins[0].lastRunMs = 1700000000000;
  store.pins[0].lastDigest = "digest-abc";
  store.pins[0].lastSummary = "P1 3 · P2 7";
  fs.writeFileSync(pinsPath, JSON.stringify(store, null, 2));
  const before = fs.readFileSync(pinsPath, "utf8");
  const pinId = store.pins[0].id;

  // A board card referencing it, then a full-list replace WITHOUT it.
  const board = boards.createBoard("Tickets");
  boards.setBoardCards(board.id, [{ pinId, size: "M" }]);
  boards.setBoardCards(board.id, []);
  assert.deepEqual(boards.listBoardRecords()[0].cards, []);

  // The pin is untouched — byte-for-byte, digest and summary intact.
  assert.equal(fs.readFileSync(pinsPath, "utf8"), before, "pins.json untouched");
  assert.equal(pinsMod.listPins().length, 1);
  assert.equal(pinsMod.listPins()[0].lastDigest, "digest-abc");

  // Deleting the whole board doesn't touch the pin either.
  boards.deleteBoard(board.id);
  assert.equal(fs.readFileSync(pinsPath, "utf8"), before);
});

test("names are unique per scope only (case-insensitive)", () => {
  freshVault();
  const alpha = inv.createInvestigation("Alpha", [], "default");
  const beta = inv.createInvestigation("Beta", [], "default");

  // The same name lives happily in the global scope AND in each
  // investigation — scopes validate separately.
  boards.createBoard("Ops");
  boards.createBoard("Ops", alpha.id);
  boards.createBoard("Ops", beta.id);

  // WITHIN a scope: case-insensitive, trim-aware rejection.
  assert.throws(() => boards.createBoard("ops"), /already exists/);
  assert.throws(() => boards.createBoard("  OPS  ", alpha.id), /already exists/);
  assert.throws(() => boards.createBoard(""), /needs a name/);
  assert.throws(() => boards.createBoard("   ", alpha.id), /needs a name/);

  // Rename obeys the same per-scope rule; its own name (a case change) is
  // allowed; the SAME name in another scope is not a collision.
  const second = boards.createBoard("Second", alpha.id);
  assert.throws(() => boards.renameBoard(second.id, "OPS"), /already exists/);
  const renamed = boards.renameBoard(second.id, "SECOND");
  assert.equal(renamed.name, "SECOND");
  assert.equal(renamed.id, second.id, "rename keeps the id");
  boards.renameBoard(second.id, "Global twin");
  boards.createBoard("Global twin"); // same name, other scope
  assert.throws(() => boards.renameBoard("board-nope", "X"), /board not found/);
});

test("virtual defaults list lazily and materialize on first mutation", () => {
  const stateDir = freshVault();
  const harbor = inv.createInvestigation("Harbor case", [], "default");

  // Nothing persisted: the "all" listing synthesizes the global "My board"
  // plus one default per investigation, deterministic ids, empty cards,
  // createdMs 0 — and writes NOTHING.
  const all = boards.listBoards();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, "default-global");
  assert.equal(all[0].name, "My board");
  assert.equal(all[0].investigationId, undefined);
  assert.deepEqual(all[0].cards, []);
  assert.equal(all[0].createdMs, 0, "virtual = never persisted");
  assert.equal(all[1].id, `default-${harbor.id}`);
  assert.equal(all[1].name, "Harbor case", "scoped default named after the investigation");
  assert.equal(all[1].investigationId, harbor.id);
  assert.ok(!fs.existsSync(path.join(stateDir, "boards.json")), "listing never writes");

  // The scoped listing returns just that scope's virtual default; an
  // unknown investigation yields nothing to name a default after.
  const scoped = boards.listBoards(harbor.id);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].id, `default-${harbor.id}`);
  assert.deepEqual(boards.listBoards("inv-nope"), []);

  // First mutation targeting the virtual id materializes it AS that id —
  // the client mutates exactly what list returned.
  const saved = boards.setBoardCards("default-global", [{ pinId: "pin-x", size: "S" }]);
  assert.equal(saved.id, "default-global");
  assert.equal(saved.name, "My board");
  assert.ok(saved.createdMs > 0, "materialized = persisted");
  assert.equal(boards.listBoardRecords().length, 1, "now a real record");
  assert.equal(boards.listBoardRecords()[0].cards.length, 1);

  // The listing no longer synthesizes a global virtual (the scope has a
  // board), while the investigation's default stays virtual.
  const relisted = boards.listBoards();
  assert.equal(relisted.length, 2);
  assert.equal(relisted[0].id, "default-global");
  assert.equal(relisted[0].cards.length, 1);
  assert.equal(relisted[1].id, `default-${harbor.id}`);
  assert.equal(relisted[1].createdMs, 0, "still virtual");

  // Renaming a virtual default materializes it under the new name.
  const named = boards.renameBoard(`default-${harbor.id}`, "Harbor wall");
  assert.equal(named.id, `default-${harbor.id}`);
  assert.equal(named.name, "Harbor wall");
  assert.equal(boards.listBoardRecords().length, 2);

  // Deleting a default — materialized or virtual — is a reset: the next
  // listing synthesizes a fresh empty virtual default again.
  boards.deleteBoard("default-global");
  boards.deleteBoard("default-global"); // virtual: Ok no-op
  const fresh = boards.listBoards().find((b) => b.id === "default-global");
  assert.ok(fresh && fresh.cards.length === 0 && fresh.createdMs === 0, "reset to virtual");

  // A default id for an unknown investigation names nothing.
  assert.throws(() => boards.setBoardCards("default-inv-nope", []), /board not found/);
  assert.throws(() => boards.renameBoard("default-inv-nope", "X"), /board not found/);
  assert.throws(() => boards.deleteBoard("default-inv-nope"), /board not found/);
});

// PARITY: boards.rs::tests::parse_cards_validates_shape_size_and_pin_id
// mirrors this table, errors byte-identical.
test("card parsing validates shape, pinId, and the size whitelist", () => {
  const ok = boards.parseBoardCards([
    { pinId: "pin-1", size: "S" },
    { pinId: "pin-2", size: "M" },
    { pinId: "pin-3", size: "L" },
  ]);
  assert.equal(ok.length, 3);
  assert.equal(ok[0].size, "S");
  assert.equal(ok[2].size, "L");
  assert.deepEqual(boards.parseBoardCards([]), [], "empty is a valid replace");

  assert.throws(
    () => boards.parseBoardCards({ pinId: "p" }),
    new Error("cards must be an array of {pinId, size}"),
  );
  assert.throws(
    () => boards.parseBoardCards(null),
    new Error("cards must be an array of {pinId, size}"),
  );
  assert.throws(() => boards.parseBoardCards([{ size: "S" }]), new Error("every card needs a pinId"));
  assert.throws(
    () => boards.parseBoardCards([{ pinId: "  ", size: "S" }]),
    new Error("every card needs a pinId"),
  );
  for (const bad of ["XL", "s", "medium", ""]) {
    assert.throws(
      () => boards.parseBoardCards([{ pinId: "p", size: bad }]),
      new Error('card size must be "S", "M", or "L"'),
      String(bad),
    );
  }
  // setBoardCards applies the same pinId floor on the typed path.
  freshVault();
  const board = boards.createBoard("Typed");
  assert.throws(
    () => boards.setBoardCards(board.id, [{ pinId: " ", size: "S" }]),
    new Error("every card needs a pinId"),
  );
});

test("refreshCards answers from stored pin state, live: false (PARITY)", () => {
  const stateDir = freshVault();

  // Stored pin state as the shared pins.json shape carries it — a healthy
  // pin with digest + summary, and a stale one with the engine's reason.
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "pins.json"),
    JSON.stringify(
      {
        pins: [
          {
            id: "pin-healthy00001",
            question: "open tickets by priority",
            sql: "SELECT 1",
            fileIds: ["tickets.csv"],
            createdMs: 7,
            lastRunMs: 1700000000000,
            lastDigest: "digest-abc",
            lastSummary: "P1 3 · P2 7",
          },
          {
            id: "pin-stale0000001",
            question: "gone file?",
            sql: "SELECT 2",
            fileIds: ["gone.csv"],
            createdMs: 8,
            lastRunMs: 1700000000001,
            staleReason: "the file is no longer available",
          },
        ],
      },
      null,
      2,
    ),
  );

  const cards = boards.refreshBoardCards(["pin-healthy00001", "pin-stale0000001", "pin-nope"]);
  assert.equal(cards.length, 3);

  // The twin NEVER executes SQL: stored state only, live: false, none of
  // the computed-now fields (markdown/chart/footer/resultDigest/error).
  assert.deepEqual(cards[0], {
    pinId: "pin-healthy00001",
    live: false,
    question: "open tickets by priority",
    lastRunMs: 1700000000000,
    lastSummary: "P1 3 · P2 7",
    lastDigest: "digest-abc",
  });
  assert.deepEqual(cards[1], {
    pinId: "pin-stale0000001",
    live: false,
    question: "gone file?",
    lastRunMs: 1700000000001,
    staleReason: "the file is no longer available",
  });

  // Unknown pin → tombstone; the board never blocks on a deleted pin.
  assert.deepEqual(cards[2], { pinId: "pin-nope", live: false, tombstone: true });
});
