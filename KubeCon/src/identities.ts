/** Sign-in identities linked to the user_id that selections are stored under (migration 0003). */
export type Provider = "cloudflare" | "google";

export const UPSERT_IDENTITY_SQL =
  "INSERT INTO identities (provider, subject, user_id, email, updated_at) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(provider, subject) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at";
export const FIND_IDENTITY_SQL = "SELECT user_id FROM identities WHERE provider = ? AND subject = ?";
export const FIND_CLOUDFLARE_BY_EMAIL_SQL =
  "SELECT user_id FROM identities WHERE provider = 'cloudflare' AND lower(email) = lower(?) ORDER BY updated_at LIMIT 1";

/** Record (or refresh) an identity. Never changes the user_id of an existing identity. */
export async function recordIdentity(db: D1Database, provider: Provider, subject: string, userId: string, email: string) {
  await db.prepare(UPSERT_IDENTITY_SQL).bind(provider, subject, userId, email, new Date().toISOString()).run();
}

export async function findIdentity(db: D1Database, provider: Provider, subject: string): Promise<string | null> {
  return (await db.prepare(FIND_IDENTITY_SQL).bind(provider, subject).first<{ user_id: string }>())?.user_id ?? null;
}

export async function findCloudflareUserByEmail(db: D1Database, email: string): Promise<string | null> {
  if (!email) return null;
  return (await db.prepare(FIND_CLOUDFLARE_BY_EMAIL_SQL).bind(email).first<{ user_id: string }>())?.user_id ?? null;
}
