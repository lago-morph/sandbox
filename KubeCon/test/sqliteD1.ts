// A small D1Database stand-in backed by real SQLite (node:sqlite), for testing actual SQL.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function sqliteD1(migrationsUpTo = Infinity) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort()) {
    if (Number(f.slice(0, 4)) <= migrationsUpTo) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  }
  const stmt = (sql: string, args: unknown[]): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    run: async () => (db.prepare(sql).run(...(args as any[])), { success: true }),
  });
  const d1 = {
    prepare: (sql: string) => stmt(sql, []),
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())),
  };
  return { raw: db, d1: d1 as unknown as D1Database };
}
