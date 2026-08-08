# Schema

Three tables, prefixed `agent_` so a future migration never collides with anything else
that might end up sharing the database.

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
  posted_at INTEGER NOT NULL,
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
```

## Why three tables, not one

`agent_sources` answers "what should I skip?" — it's the dedup state, one row per source,
overwritten in place. `agent_notifications` answers "what did I actually post?" — it's an
append-only history. `agent_runs` answers "did the bot itself work?" — it's an
observability log, independent of whether any individual source produced a notification.
Merging these would make each question harder to answer: putting `last_posted_at` only on
`agent_notifications`, for instance, would turn "what's the current dedup state for
weather?" into a query that has to find the most recent row and hope nothing raced it,
instead of a primary-key lookup.

## Why both `value` and `formatted_message`

Dedup has to compare against something byte-for-byte stable: the same weather reading
should always produce the same string. The LLM-formatted message is the opposite —
non-deterministic by design, because the whole point of running it through Bedrock is to
get natural, varied phrasing. If dedup compared `formatted_message` instead of `value`,
an unchanged `72F` reading would produce a different message every time it was checked,
and the dedup logic would never fire — every run would post, defeating the entire feature
and burning an LLM call it didn't need to. `value` is what dedup reads; `formatted_message`
is what a human reads. Storing both means the reader can show what was actually posted
without paying for a second Bedrock call just to redisplay it.

## Why `outcome` and `error` are nullable

An `agent_runs` row is inserted at the *start* of a run, before any work happens, and
updated at the end. A row where `ended_at` is still `NULL` is not missing data — it's a
record that the process crashed or was killed mid-run, which is exactly the failure mode
you'd otherwise have no visibility into. Defaulting `outcome` to some placeholder value
would erase that signal.

## Why `source` is a closed vocabulary

The `CHECK` constraint on `agent_sources.name` accepts only `'weather'` and `'crypto'`. A
typo like `'wether'` would otherwise silently create a third, orphaned dedup row that
never gets checked against — the bug would look like "the weather bot stopped noticing
changes," which is a much harder thing to debug than a constraint violation at insert
time. Extending the tutorial to a third source means editing this one constraint plus one
new `SourceFetcher` — see [docs/04-extending.md](04-extending.md).
