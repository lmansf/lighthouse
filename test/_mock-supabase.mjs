/**
 * In-memory stand-in for `@supabase/supabase-js`, faithful to the slice of the
 * query-builder API the license Edge Function's `assign` op actually uses:
 *
 *   .from(t).select("variant").eq(..).eq(..).limit(1)        -> { data, error }
 *   .from(t).select("*", { count:"exact", head:true })
 *           .eq(..).eq(..)                                    -> { count, error }   (no data!)
 *   .from(t).insert(row)                                      -> { error }
 *
 * The store enforces the real table's `unique (contact_id, experiment)` so the
 * function's idempotency holds. Control hooks let a test simulate a missing
 * migration (every op errors) and a lost insert race (the count-then-insert gap).
 */
const tables = new Map(); // name -> rows[]
let broken = false; // simulate "relation does not exist" (un-migrated table)
let forceInsertConflict = null; // null | "store" | "nostore" — simulate a concurrent insert

export function __reset() {
  tables.clear();
  broken = false;
  forceInsertConflict = null;
  stats.headCount = 0;
  stats.fullSelect = 0;
}
export function __setBroken(b) {
  broken = b;
}
/** Make the next insert behave as if another writer won the race. */
export function __forceNextInsertConflict(mode /* "store" | "nostore" */) {
  forceInsertConflict = mode;
}
export function __rows(name) {
  return [...(tables.get(name) ?? [])];
}
export const stats = { headCount: 0, fullSelect: 0 };

function rowsFor(name) {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name);
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this._head = false;
    this._count = null;
    this._limit = null;
    this._op = "select";
    this._row = null;
  }
  select(_cols, opts) {
    this._op = "select";
    if (opts) {
      this._count = opts.count ?? null;
      this._head = Boolean(opts.head);
    }
    return this;
  }
  insert(row) {
    this._op = "insert";
    this._row = row;
    return this;
  }
  eq(col, val) {
    this.filters.push([col, val]);
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  _match() {
    return rowsFor(this.table).filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  async _run() {
    if (broken) {
      return { data: null, count: null, error: { message: `relation "${this.table}" does not exist` } };
    }
    if (this._op === "select") {
      const matched = this._match();
      if (this._head) {
        stats.headCount += 1;
        return { data: null, count: matched.length, error: null }; // head:true returns NO rows
      }
      stats.fullSelect += 1;
      const data = this._limit != null ? matched.slice(0, this._limit) : matched;
      return { data, count: this._count != null ? matched.length : null, error: null };
    }
    if (this._op === "insert") {
      const dup = rowsFor(this.table).some(
        (r) => r.contact_id === this._row.contact_id && r.experiment === this._row.experiment,
      );
      const conflict = forceInsertConflict;
      if (conflict) {
        forceInsertConflict = null;
        if (conflict === "store") rowsFor(this.table).push({ ...this._row, created_at: new Date().toISOString() });
        return { error: { message: "duplicate key value violates unique constraint", code: "23505" } };
      }
      if (dup) {
        return { error: { message: "duplicate key value violates unique constraint", code: "23505" } };
      }
      rowsFor(this.table).push({ ...this._row, created_at: new Date().toISOString() });
      return { error: null };
    }
    return { data: null, error: null };
  }
  then(resolve, reject) {
    return this._run().then(resolve, reject);
  }
}

export function createClient() {
  return { from: (table) => new Query(table) };
}
