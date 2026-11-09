CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- Sessionize id
  source TEXT NOT NULL,           -- main | colocated | maintainer | sponsor
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,              -- YYYY-MM-DD (local)
  starts_at TEXT NOT NULL,        -- YYYY-MM-DDTHH:MM:SS (local, no offset)
  ends_at TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  track TEXT NOT NULL,
  format TEXT,
  events TEXT NOT NULL DEFAULT '[]',    -- JSON array of event names
  speakers TEXT NOT NULL DEFAULT '[]',  -- JSON [{name, company, title}]
  speaker_text TEXT NOT NULL DEFAULT '' -- "Name (Company), Name" for list + search
);
CREATE INDEX sessions_day ON sessions(day, starts_at);
CREATE TABLE selections (
  user_id TEXT NOT NULL,          -- Cloudflare user id
  session_id TEXT NOT NULL,       -- Sessionize id; no FK (survives re-import)
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);  -- last_import_at, last_import_result
