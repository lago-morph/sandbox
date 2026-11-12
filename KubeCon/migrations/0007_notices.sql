-- "What's new" notices each user has already been shown (each is shown exactly once per user).
CREATE TABLE notices_seen (
  user_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, notice_id)
);
