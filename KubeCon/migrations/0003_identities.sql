-- Links sign-in identities (Cloudflare, Google) to the user_id that selections are stored under.
-- Cloudflare identities use their Cloudflare user id as user_id, so existing selections keep working.
CREATE TABLE identities (
  provider TEXT NOT NULL,      -- cloudflare | google
  subject TEXT NOT NULL,       -- provider's user id (Cloudflare user id, Google sub)
  user_id TEXT NOT NULL,       -- selections.user_id
  email TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_email ON identities(provider, email);
