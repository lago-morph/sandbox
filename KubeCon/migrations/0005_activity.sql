-- Activity log for debugging usage counts: one row each time a signed-in user does something
-- (any authenticated API request, including the client's throttled activity ping).
-- Records only who and when, never what.
CREATE TABLE activity (
  user_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL      -- Unix epoch milliseconds
);
CREATE INDEX activity_user_at ON activity(user_id, at_ms);
