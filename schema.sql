CREATE TABLE IF NOT EXISTS intakes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item        TEXT NOT NULL,
  brand       TEXT,
  daily_qty   REAL,
  source      TEXT,
  payment     TEXT,
  listing_id  TEXT
);
