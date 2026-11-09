/**
 * Automatic schedule refresh (Cron Trigger in wrangler.jsonc).
 * The cron runs at 13:00-23:00 UTC every 2 hours on 8-12 November, which is 06:00-16:00
 * Salt Lake City time (MST, UTC-7). Cron has no year, so the run is also limited here to the
 * conference days of 2026 in Salt Lake City time.
 */
import { runImport } from "./importer";
import type { Env } from "./types";

export const CONFERENCE_DAYS = new Set(["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);

/** Salt Lake City (America/Denver) calendar date of an instant, as YYYY-MM-DD. */
export function slcDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

/** Salt Lake City hour (0-23) of an instant. */
export function slcHour(ms: number): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "2-digit", hourCycle: "h23" }).format(new Date(ms)));
}

/** True when a scheduled run at this instant should refresh: a conference day, 06:00 to 16:00 local. */
export function shouldRefresh(ms: number): boolean {
  const h = slcHour(ms);
  return CONFERENCE_DAYS.has(slcDate(ms)) && h >= 6 && h <= 16;
}

export async function scheduledRefresh(scheduledTime: number, env: Env, importImpl = runImport): Promise<string> {
  if (!shouldRefresh(scheduledTime)) return "skipped: outside conference days or hours";
  try {
    const r = await importImpl(env.DB);
    return `refreshed: ${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.total} total`;
  } catch (e) {
    return `refresh failed: ${(e as Error).message}`;
  }
}
