/**
 * "What's new" notices. Each is shown exactly once per user (recorded in notices_seen, so it is
 * once across all their devices), and only to users who were already using the app before the
 * feature it announces (a users row first seen, or a selection made, before `since`).
 */
export interface Notice {
  id: string;
  /** Unix ms: users active before this are "returning" and get the notice. */
  since: number;
  title: string;
  text: string;
}

export const NOTICES: Notice[] = [
  {
    id: "download-link",
    since: Date.parse("2026-11-12T23:50:00Z"),
    title: "What's new",
    text: "You can now download your ★ favorite and ✓ interested sessions, with full Sessionize details. Tap the share icon at the top to get a download link.",
  },
];

export const UNSEEN_NOTICE_SQL =
  "SELECT NOT EXISTS (SELECT 1 FROM notices_seen WHERE user_id = ?1 AND notice_id = ?2) AND (" +
  "EXISTS (SELECT 1 FROM users WHERE user_id = ?1 AND first_seen_ms < ?3) OR " +
  "EXISTS (SELECT 1 FROM selections WHERE user_id = ?1 AND created_at < ?4)) AS show";
export const MARK_NOTICE_SEEN_SQL = "INSERT OR IGNORE INTO notices_seen (user_id, notice_id, seen_at) VALUES (?, ?, ?)";

/** Notices this user has not seen yet and that apply to them. */
export async function unseenNotices(db: D1Database, userId: string): Promise<Pick<Notice, "id" | "title" | "text">[]> {
  const out: Pick<Notice, "id" | "title" | "text">[] = [];
  for (const n of NOTICES) {
    const r = await db.prepare(UNSEEN_NOTICE_SQL).bind(userId, n.id, n.since, new Date(n.since).toISOString()).first<{ show: number }>();
    if (r?.show) out.push({ id: n.id, title: n.title, text: n.text });
  }
  return out;
}

/** Record that the user was shown a notice. Unknown ids are ignored. */
export async function markNoticeSeen(db: D1Database, userId: string, noticeId: string): Promise<boolean> {
  if (!NOTICES.some((n) => n.id === noticeId)) return false;
  await db.prepare(MARK_NOTICE_SEEN_SQL).bind(userId, noticeId, new Date().toISOString()).run();
  return true;
}
