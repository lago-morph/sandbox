import { describe, expect, it } from "vitest";
import { scheduledRefresh, shouldRefresh } from "../src/scheduled";
import type { Env } from "../src/types";

// Cron "0 13-23/2 8-12 11 *" fires at these UTC hours on 8-12 November.
const CRON_HOURS_UTC = [13, 15, 17, 19, 21, 23];
const at = (date: string, hourUtc: number) => Date.parse(`${date}T${String(hourUtc).padStart(2, "0")}:00:00Z`);

describe("scheduled refresh window", () => {
  it("cron hours map to 06:00-16:00 Salt Lake City time every 2 hours on each conference day", () => {
    const local = CRON_HOURS_UTC.map((h) =>
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at("2026-11-10", h))),
    );
    expect(local).toEqual(["06:00", "08:00", "10:00", "12:00", "14:00", "16:00"]);
    for (const d of ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) {
      for (const h of CRON_HOURS_UTC) expect(shouldRefresh(at(d, h))).toBe(true);
    }
  });

  it("does not refresh outside the 2026 conference days or hours", () => {
    expect(shouldRefresh(at("2026-11-07", 15))).toBe(false); // day before
    expect(shouldRefresh(at("2026-11-13", 15))).toBe(false); // day after
    expect(shouldRefresh(at("2027-11-10", 15))).toBe(false); // cron fires again next year
    expect(shouldRefresh(at("2026-11-10", 12))).toBe(false); // 05:00 local
    expect(shouldRefresh(at("2026-11-11", 0))).toBe(false); // 17:00 local on the 10th
  });

  it("runs the import inside the window and skips it outside", async () => {
    const env = { DB: {} } as Env;
    let calls = 0;
    const fake = async () => (calls++, { added: 0, updated: 2, removed: 0, total: 854 });
    expect(await scheduledRefresh(at("2026-11-10", 13), env, fake)).toBe("refreshed: 0 added, 2 updated, 0 removed, 854 total");
    expect(await scheduledRefresh(at("2026-11-13", 13), env, fake)).toMatch(/^skipped/);
    expect(calls).toBe(1);
    const failing = async () => { throw new Error('Feed "main" failed: HTTP 503'); };
    expect(await scheduledRefresh(at("2026-11-10", 13), env, failing)).toBe('refresh failed: Feed "main" failed: HTTP 503');
  });
});
