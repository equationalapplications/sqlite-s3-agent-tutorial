/** Closed vocabulary for `agent_sources.name` (spec §5). Extend by editing this array
 *  and the CHECK constraint below — the tutorial is intentionally narrow. */
export const SOURCE_NAMES = ['weather', 'crypto'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

/** DDL for all tables, including the `agent_embeddings` vector table (RAG design spec
 *  §3.1). Applied via `CREATE TABLE IF NOT EXISTS` / `CREATE VIRTUAL TABLE IF NOT
 *  EXISTS`, so re-running it against an already-bootstrapped database is a no-op (spec
 *  §4.1). Requires the `sqlite-vec` extension to already be loaded on the connection —
 *  `openDatabase` (src/db/open.ts) does this before `bootstrap()` runs. */
export const AGENT_DDL = `
CREATE TABLE IF NOT EXISTS agent_sources (
  name              TEXT PRIMARY KEY,
  last_value        TEXT,
  last_fetched_at   INTEGER,
  last_posted_at    INTEGER,
  CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto'))
);

CREATE TABLE IF NOT EXISTS agent_notifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source             TEXT    NOT NULL,
  value              TEXT    NOT NULL,
  formatted_message  TEXT    NOT NULL,
  posted_at          INTEGER NOT NULL,
  FOREIGN KEY (source) REFERENCES agent_sources(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_notifications_source_posted_at
  ON agent_notifications(source, posted_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id              TEXT PRIMARY KEY,
  op                  TEXT NOT NULL,
  snapshot_version_in TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  outcome             TEXT,
  sources_checked     INTEGER,
  notifications_sent  INTEGER,
  error               TEXT,
  CONSTRAINT chk_op      CHECK (op IN ('fetch', 'status')),
  CONSTRAINT chk_outcome CHECK (outcome IS NULL OR outcome IN ('success', 'error'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_embeddings USING vec0(
  notification_id INTEGER PRIMARY KEY,
  embedding        FLOAT[256] distance_metric=cosine
);
`;
