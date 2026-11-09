-- Selection state: 'favorite' (plan to attend) or 'interested' (watch the recording later).
-- Existing selections were all favorites.
ALTER TABLE selections ADD COLUMN status TEXT NOT NULL DEFAULT 'favorite';
