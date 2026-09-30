-- Accounts plus the denormalised game stats the leaderboard reads (kept in sync by src/game.ts).
CREATE TABLE players (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL,
  username_lc   TEXT    NOT NULL UNIQUE,
  pass_hash     TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  session_gen   INTEGER NOT NULL DEFAULT 0,   -- bumped to invalidate existing session cookies
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,   -- epoch ms
  rerolls       INTEGER NOT NULL DEFAULT 5,
  approved_mask INTEGER NOT NULL DEFAULT 0,   -- bit n set = card position n approved
  points        INTEGER NOT NULL DEFAULT 0,   -- approved squares (0-24)
  lines         INTEGER NOT NULL DEFAULT 0,   -- completed rows/columns/diagonals (0-12)
  line_at       INTEGER,                      -- epoch ms of first completed line
  bingo_at      INTEGER,                      -- epoch ms of full card
  created_at    INTEGER NOT NULL
);

CREATE TABLE phrases (
  id   INTEGER PRIMARY KEY,
  text TEXT NOT NULL
);

-- One row per square. pos 0-23 skips the FREE centre square of the 5x5 grid.
CREATE TABLE cells (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  pos       INTEGER NOT NULL CHECK (pos BETWEEN 0 AND 23),
  phrase_id INTEGER NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
  state     TEXT    NOT NULL DEFAULT 'none' CHECK (state IN ('none', 'pending', 'approved')),
  PRIMARY KEY (player_id, pos)
);

-- Serves both the moderator's pending list and approve/reject by phrase without full scans.
CREATE INDEX idx_cells_state_phrase ON cells (state, phrase_id);

-- Single counter bumped on every write; clients poll it to know when to refetch.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO meta (key, value) VALUES ('version', 1);
