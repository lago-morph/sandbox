// npm run backup: copy every row of the selections table (user data that cannot be re-imported)
// from D1 into the R2 bucket kubecon-planner-backups, then read it back to verify.
// Sessions are not backed up: they are re-imported from Sessionize. Exits non-zero on any failure.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrangler } from "./wr.mjs";

const DB = "kubecon-planner";
const BUCKET = "kubecon-planner-backups";

function parseD1(out) {
  const json = JSON.parse(out.slice(out.indexOf("[")));
  if (!json[0]?.success || !Array.isArray(json[0].results)) throw new Error("D1 query did not succeed");
  return json[0].results;
}

export async function backup(label = "manual") {
  const rows = parseD1(
    await wrangler(["d1", "execute", DB, "--remote", "--json", "--command", "SELECT * FROM selections ORDER BY user_id, created_at, session_id"], { quiet: true }),
  );
  const takenAt = new Date().toISOString();
  const body = JSON.stringify({ takenAt, label, table: "selections", count: rows.length, rows });
  const key = `selections/${takenAt.replace(/[:.]/g, "-")}-${label}.json`;

  const dir = mkdtempSync(join(tmpdir(), "kp-backup-"));
  try {
    const file = join(dir, "backup.json");
    writeFileSync(file, body);
    await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", "application/json", "--remote"], { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const stored = await wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--pipe", "--remote"], { quiet: true });
  const check = JSON.parse(stored.slice(stored.indexOf("{")));
  if (check.count !== rows.length || check.rows.length !== rows.length) throw new Error("Backup read-back did not match");
  console.log(`Backed up ${rows.length} selection(s) to r2://${BUCKET}/${key} (verified)`);
  return { key, count: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backup(process.argv[2] || "manual").catch((e) => {
    console.error(`Backup FAILED: ${e.message}`);
    process.exit(1);
  });
}
