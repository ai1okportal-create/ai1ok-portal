PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cabinets (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  public_number INTEGER NOT NULL UNIQUE,
  public_name TEXT NOT NULL,
  cabinet_type TEXT NOT NULL,
  directions TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'offline',
  visibility TEXT NOT NULL DEFAULT 'hidden',
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(public_name) BETWEEN 2 AND 80),
  CHECK (length(directions) <= 350),
  CHECK (length(about) <= 600),
  CHECK (availability IN ('ready', 'busy', 'offline', 'hidden')),
  CHECK (visibility IN ('visible', 'hidden')),
  CHECK (review_status IN ('pending', 'approved', 'hidden'))
);

CREATE INDEX IF NOT EXISTS idx_cabinets_owner ON cabinets(owner_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cabinets_showcase ON cabinets(review_status, visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS contact_requests (
  id TEXT PRIMARY KEY,
  from_cabinet_id TEXT NOT NULL,
  to_cabinet_id TEXT NOT NULL,
  message TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  responded_at TEXT,
  FOREIGN KEY (from_cabinet_id) REFERENCES cabinets(id) ON DELETE CASCADE,
  FOREIGN KEY (to_cabinet_id) REFERENCES cabinets(id) ON DELETE CASCADE,
  CHECK (from_cabinet_id <> to_cabinet_id),
  CHECK (length(message) BETWEEN 1 AND 500),
  CHECK (state IN ('pending', 'accepted', 'declined', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_requests_to ON contact_requests(to_cabinet_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_from ON contact_requests(from_cabinet_id, state, created_at DESC);
