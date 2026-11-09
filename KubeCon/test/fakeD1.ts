import { DELETE_SQL, META_SQL, SELECT_ALL_SQL, UPSERT_SQL } from "../src/importer";
import { UPSERT_SELECTION_SQL } from "../src/index";

const COLS = ["id", "source", "title", "description", "day", "starts_at", "ends_at", "room", "track", "format", "events", "speakers", "speaker_text"];

/** Minimal in-memory stand-in for the D1 statements the importer and API use. */
export class FakeD1 {
  sessions = new Map<string, Record<string, unknown>>();
  selections = new Map<string, { user_id: string; session_id: string; status: string; created_at: string }>();
  meta = new Map<string, string>();
  batches: number[] = [];

  prepare(sql: string) {
    const db = this;
    const stmt = (args: unknown[]) => ({
      sql,
      args,
      bind: (...a: unknown[]) => stmt(a),
      async all() {
        if (sql === SELECT_ALL_SQL) return { results: [...db.sessions.values()] };
        if (sql.startsWith("SELECT session_id"))
          return { results: [...db.selections.values()].filter((s) => s.user_id === args[0]) };
        throw new Error(`FakeD1: unsupported all() ${sql}`);
      },
      async first() {
        if (sql.startsWith("SELECT v FROM meta")) return db.meta.has("last_import_at") ? { v: db.meta.get("last_import_at") } : null;
        if (sql.startsWith("SELECT 1 AS x FROM sessions")) return db.sessions.has(String(args[0])) ? { x: 1 } : null;
        throw new Error(`FakeD1: unsupported first() ${sql}`);
      },
      async run() {
        if (sql === UPSERT_SQL) db.sessions.set(String(args[0]), Object.fromEntries(COLS.map((c, i) => [c, args[i]])));
        else if (sql === DELETE_SQL) db.sessions.delete(String(args[0]));
        else if (sql === META_SQL) db.meta.set(String(args[0]), String(args[1]));
        else if (sql === UPSERT_SELECTION_SQL) {
          const k = `${args[0]}|${args[1]}`;
          const prev = db.selections.get(k);
          db.selections.set(k, { user_id: String(args[0]), session_id: String(args[1]), status: String(args[2]), created_at: prev?.created_at ?? String(args[3]) });
        } else if (sql.startsWith("DELETE FROM selections")) db.selections.delete(`${args[0]}|${args[1]}`);
        else throw new Error(`FakeD1: unsupported run() ${sql}`);
        return { success: true };
      },
    });
    return stmt([]);
  }

  async batch(stmts: { run(): Promise<unknown> }[]) {
    if (stmts.length > 100) throw new Error("batch too large");
    this.batches.push(stmts.length);
    for (const s of stmts) await s.run();
    return [];
  }
}
