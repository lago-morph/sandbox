-- Usage tracking. One row per signed-in identity (selections.user_id).
-- A "visit" is counted on first use and whenever the user is active more than 15 minutes after
-- their previous activity (see src/usage.ts). Times are Unix epoch milliseconds.
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,         -- cloudflare | google
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  visits INTEGER NOT NULL DEFAULT 1
);
-- Backfill users who already have selections (their earlier visits were not tracked, so 1 visit each).
INSERT INTO users (user_id, provider, first_seen_ms, last_seen_ms, visits)
SELECT user_id,
       CASE WHEN user_id LIKE 'google:%' THEN 'google' ELSE 'cloudflare' END,
       CAST(ROUND((julianday(MIN(created_at)) - 2440587.5) * 86400000) AS INTEGER),
       CAST(ROUND((julianday(MAX(created_at)) - 2440587.5) * 86400000) AS INTEGER),
       1
FROM selections GROUP BY user_id;
