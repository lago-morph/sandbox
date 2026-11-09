/** Usage tracking for the admin stats page (migration 0004). */
import type { Provider } from "./auth";

/** Activity more than this long after the previous activity counts as a new visit. */
export const VISIT_GAP_MS = 15 * 60 * 1000;
/** "Engaged" users have more than this many visits. */
export const ENGAGED_VISITS = 5;

export const TOUCH_USER_SQL =
  "INSERT INTO users (user_id, provider, first_seen_ms, last_seen_ms, visits) VALUES (?1, ?2, ?3, ?3, 1) " +
  `ON CONFLICT(user_id) DO UPDATE SET visits = users.visits + (CASE WHEN ?3 - users.last_seen_ms > ${VISIT_GAP_MS} THEN 1 ELSE 0 END), ` +
  "last_seen_ms = MAX(users.last_seen_ms, ?3)";

export const STATS_SQL =
  `SELECT COUNT(*) AS registered, COALESCE(SUM(CASE WHEN visits > ${ENGAGED_VISITS} THEN 1 ELSE 0 END), 0) AS engaged FROM users`;

/** Record activity by a signed-in user. Called on every authenticated API request. */
export async function touchUser(db: D1Database, userId: string, provider: Provider, nowMs = Date.now()): Promise<void> {
  await db.prepare(TOUCH_USER_SQL).bind(userId, provider, nowMs).run();
}

export interface Stats {
  registered: number;
  engaged: number;
}

export async function getStats(db: D1Database): Promise<Stats> {
  const r = await db.prepare(STATS_SQL).first<{ registered: number; engaged: number }>();
  return { registered: Number(r?.registered ?? 0), engaged: Number(r?.engaged ?? 0) };
}
