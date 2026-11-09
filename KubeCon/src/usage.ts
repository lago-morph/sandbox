/** Usage tracking for the admin stats page (migration 0004). */
import type { Provider } from "./auth";

/** Activity more than this long after the previous activity counts as a new visit. */
export const VISIT_GAP_MS = 15 * 60 * 1000;
/** "Engaged" users have at least this many visits. */
export const ENGAGED_MIN_VISITS = 3;

/** At most one write per user per this interval (users row and activity row), to bound D1 writes. */
export const WRITE_EVERY_MS = 60 * 1000;

export const TOUCH_USER_SQL =
  "INSERT INTO users (user_id, provider, first_seen_ms, last_seen_ms, visits) VALUES (?1, ?2, ?3, ?3, 1) " +
  `ON CONFLICT(user_id) DO UPDATE SET visits = users.visits + (CASE WHEN ?3 - users.last_seen_ms > ${VISIT_GAP_MS} THEN 1 ELSE 0 END), ` +
  `last_seen_ms = ?3 WHERE ?3 - users.last_seen_ms >= ${WRITE_EVERY_MS}`;

export const STATS_SQL =
  `SELECT COUNT(*) AS registered, COALESCE(SUM(CASE WHEN visits >= ${ENGAGED_MIN_VISITS} THEN 1 ELSE 0 END), 0) AS engaged FROM users`;

export const LOG_ACTIVITY_SQL =
  "INSERT INTO activity (user_id, at_ms) SELECT ?1, ?2 " +
  `WHERE NOT EXISTS (SELECT 1 FROM activity WHERE user_id = ?1 AND at_ms > ?2 - ${WRITE_EVERY_MS})`;

/**
 * Record activity by a signed-in user (who and when only). Called on every authenticated API
 * request, including the client's throttled POST /api/ping. Updates the visit counter and appends
 * to the activity log in one batch.
 */
export async function touchUser(db: D1Database, userId: string, provider: Provider, nowMs = Date.now()): Promise<void> {
  await db.batch([
    db.prepare(TOUCH_USER_SQL).bind(userId, provider, nowMs),
    db.prepare(LOG_ACTIVITY_SQL).bind(userId, nowMs),
  ]);
}

export interface Stats {
  registered: number;
  engaged: number;
}

export async function getStats(db: D1Database): Promise<Stats> {
  const r = await db.prepare(STATS_SQL).first<{ registered: number; engaged: number }>();
  return { registered: Number(r?.registered ?? 0), engaged: Number(r?.engaged ?? 0) };
}
