-- Links from the Sessionize feed: slide download (session question "Presentation Slides")
-- and recording (session recordingUrl). Empty until the next schedule import fills them.
ALTER TABLE sessions ADD COLUMN slides_url TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN recording_url TEXT NOT NULL DEFAULT '';
