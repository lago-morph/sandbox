-- Nightly email summaries of changes to each subscriber's favorite/interested sessions.

-- All https links Sessionize publishes for a session, keyed by kind (Slides, Recording,
-- Live stream, GitHub, Demo, Website). Filled by the next schedule import.
ALTER TABLE sessions ADD COLUMN links TEXT NOT NULL DEFAULT '{}';

-- One row per user who asked for summaries. status: pending (confirmation email sent),
-- active (confirmed), off.
CREATE TABLE email_subs (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL
);

-- What each subscriber's selected sessions looked like when last summarized, to detect changes.
CREATE TABLE email_snapshots (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

-- Delivery log for debugging (no addresses or content).
CREATE TABLE email_log (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- confirm | summary
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
