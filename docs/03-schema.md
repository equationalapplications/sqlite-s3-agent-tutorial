# Schema

Four tables (three relational plus one vector table), prefixed `agent_` so a future
migration never collides with anything else that might end up sharing the database.

```sql
CREATE TABLE agent_sources (
  name TEXT PRIMARY KEY,
  last_value TEXT,
  last_fetched_at INTEGER,
  last_posted_at INTEGER,
  CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto'))
);

CREATE TABLE agent_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  value TEXT NOT NULL,
  formatted_message TEXT NOT NULL,
  base_message TEXT,
  posted_at INTEGER NOT NULL,
  nearest_match_id INTEGER REFERENCES agent_notifications(id),
  nearest_match_distance REAL,
  FOREIGN KEY (source) REFERENCES agent_sources(name) ON DELETE CASCADE
);

CREATE INDEX idx_agent_notifications_source_posted_at
  ON agent_notifications(source, posted_at DESC);

CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  snapshot_version_in TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  sources_checked INTEGER,
  notifications_sent INTEGER,
  error TEXT,
  CONSTRAINT chk_op      CHECK (op IN ('fetch', 'status')),
  CONSTRAINT chk_outcome CHECK (outcome IS NULL OR outcome IN ('success', 'error'))
);

CREATE VIRTUAL TABLE agent_embeddings USING vec0(
  notification_id INTEGER PRIMARY KEY,
  embedding        FLOAT[256] distance_metric=cosine
);
```

`base_message`, `nearest_match_id`, and `nearest_match_distance` were added after the
initial three-table design, by `src/db/bootstrap.ts`'s `addMissingColumns` rather than by
`CREATE TABLE` — SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so bootstrap
feature-detects each column via `PRAGMA table_info` before adding it. That keeps
`bootstrap()` idempotent across a database created before these columns existed and one
created after, without a separate migration-versioning mechanism. See
[docs/08-rag-vector-search.md](08-rag-vector-search.md) for what these columns and
`agent_embeddings` are for.

## No dedup

An earlier version of this tutorial skipped posting when a source's raw value was
unchanged since the last tick, using `agent_sources.last_value` as the comparison. That
check was removed: at a 5-minute loop cadence the point of every tick is the LLM's varied
phrasing and haiku, not the underlying reading, so "the weather didn't change" is not a
reason to skip a tick. `agent_sources` is still written every tick — `last_value`,
`last_fetched_at`, and `last_posted_at` are simply a last-seen record now, useful for the
`status` endpoint and for debugging a stalled source, not a gate on whether a post
happens.

## Why three relational tables, not one

`agent_sources` answers "what did I last see, per source?" — one row per source,
overwritten in place. `agent_notifications` answers "what did I actually post?" — it's an
append-only history. `agent_runs` answers "did the bot itself work?" — it's an
observability log, independent of whether any individual source produced a notification.
Merging these would make each question harder to answer: putting `last_posted_at` only on
`agent_notifications`, for instance, would turn "what's the last-seen state for weather?"
into a query that has to find the most recent row and hope nothing raced it, instead of a
primary-key lookup.

## Why both `value` and `formatted_message`

`value` is the raw, byte-for-byte-stable reading (`"72F"`); `formatted_message` is the
LLM's non-deterministic prose. Even without dedup, keeping them separate matters: `value`
is what a future feature (or a reader debugging a weird post) can compare against a known
input, while `formatted_message` is what a human actually read in Discord. Storing both
means the reader can show what was posted without paying for a second Bedrock call just to
redisplay it, and `base_message` (the LLM's pre-suffix output, stored separately from
`formatted_message`) is what the RAG suffix is built from — see
[docs/08-rag-vector-search.md](08-rag-vector-search.md) for why that distinction exists.

## Why `outcome` and `error` are nullable

An `agent_runs` row is inserted at the *start* of a run, before any work happens, and
updated at the end. A row where `ended_at` is still `NULL` is not missing data — it's a
record that the process crashed or was killed mid-run, which is exactly the failure mode
you'd otherwise have no visibility into. Defaulting `outcome` to some placeholder value
would erase that signal.

## Why `source` is a closed vocabulary

The `CHECK` constraint on `agent_sources.name` accepts only `'weather'` and `'crypto'`. A
typo like `'wether'` would otherwise silently create a third, orphaned row in
`agent_sources` that never gets updated by any real fetcher — the bug would look like "the
weather source stopped reporting," which is a much harder thing to debug than a constraint
violation at insert time. Extending the tutorial to a third source means editing this one
constraint plus one new `SourceFetcher` — see [docs/04-extending.md](04-extending.md).
