import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openReadOnlyDatabase } from '../db/open.js';
import type { Store } from '../store/types.js';

export interface SourceStatus {
  name: string;
  lastValue: string | null;
  lastFetchedAt: number | null;
  lastPostedAt: number | null;
}

export interface NotificationStatus {
  source: string;
  value: string;
  formattedMessage: string;
  postedAt: number;
  /** The closest past tick's notification (global match, no per-source filter — see
   *  src/rag/similarity.ts) at the time this one was posted, or `null` if this was the
   *  first tick ever, or the RAG lookup failed and was isolated — the two cases are
   *  indistinguishable here on purpose, since neither has a match to show. Populated
   *  once, at write time, by `runFetch`; this module never runs a vector query itself. */
  nearestMatch: {
    source: string;
    formattedMessage: string;
    postedAt: number;
    distance: number;
  } | null;
}

export interface StatusResult {
  snapshotVersion: string | null;
  sources: SourceStatus[];
  recentNotifications: NotificationStatus[];
}

/** Rows returned per `status` call, across all sources (spec §3.2 step 4). Not
 *  configurable — the reader is a diagnostic JSON endpoint, not a paginated API (spec §2). */
const RECENT_NOTIFICATIONS_LIMIT = 10;

interface ReaderState {
  cachedEtag: string | null;
  db: Database.Database | undefined;
}

export interface StatusReader {
  getStatus(store: Store, storeKey: string): Promise<StatusResult>;
  /**
   * Test-only: returns a snapshot of the internal reader state for assertions on the
   * cache invariant (spec §4.3.1). Production code must not rely on this — it exposes
   * implementation detail that the public contract deliberately does not promise.
   */
  __peekReaderState(): { cachedEtag: string | null; dbIsOpen: boolean };
}

/** Shape every notifications row is normalized to before being mapped into
 *  `NotificationStatus`, regardless of whether the RAG columns are present on the
 *  underlying table. Lets the map step stay column-shape-agnostic. */
interface NotificationRow {
  source: string;
  value: string;
  formatted_message: string;
  posted_at: number;
  nearest_match_distance: number | null;
  matched_source: string | null;
  matched_formatted_message: string | null;
  matched_posted_at: number | null;
}

function queryStatus(db: Database.Database, etag: string): StatusResult {
  // ORDER BY name keeps the sources list deterministic across SQLite versions and
  // vacuuming — without it, SQL does not guarantee row order.
  const sources = db
    .prepare(`SELECT name, last_value, last_fetched_at, last_posted_at FROM agent_sources ORDER BY name`)
    .all() as Array<{ name: string; last_value: string | null; last_fetched_at: number | null; last_posted_at: number | null }>;

  // `nearest_match_id` and `nearest_match_distance` were added by the writer's
  // bootstrap, not by the base schema's `CREATE TABLE`. A `memory.db` snapshot from
  // before the RAG feature shipped doesn't have them, and the read-only status
  // endpoint can be invoked against such a snapshot before the next fetch run has
  // had a chance to migrate it — in which case the joined query below would throw
  // `no such column: n.nearest_match_distance`. Feature-detect via `PRAGMA
  // table_info`, mirroring `addMissingColumns` in `src/db/bootstrap.ts`,
  // and fall back to the pre-RAG query so the endpoint stays a plain diagnostic.
  const columnNames = new Set(
    (db.prepare(`PRAGMA table_info(agent_notifications)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const hasRagColumns = columnNames.has('nearest_match_id') && columnNames.has('nearest_match_distance');

  // id DESC is a tie-breaker for notifications that share the same posted_at — without
  // it, the LIMIT picks an arbitrary subset and the endpoint output is not stable. The
  // LEFT JOIN pulls the matched notification's own source/message/postedAt so the status
  // endpoint is self-contained — no vector search happens here, only a second read of
  // already-open agent_notifications (RAG design spec §7).
  const notifications: NotificationRow[] = hasRagColumns
    ? (db
        .prepare(
          `SELECT n.source, n.value, n.formatted_message, n.posted_at, n.nearest_match_distance,
                  m.source AS matched_source, m.formatted_message AS matched_formatted_message,
                  m.posted_at AS matched_posted_at
           FROM agent_notifications n
           LEFT JOIN agent_notifications m ON m.id = n.nearest_match_id
           ORDER BY n.posted_at DESC, n.id DESC LIMIT ?`,
        )
        .all(RECENT_NOTIFICATIONS_LIMIT) as NotificationRow[])
    : (
        db
          .prepare(
            `SELECT source, value, formatted_message, posted_at FROM agent_notifications
             ORDER BY posted_at DESC, id DESC LIMIT ?`,
          )
          .all(RECENT_NOTIFICATIONS_LIMIT) as Array<{
          source: string;
          value: string;
          formatted_message: string;
          posted_at: number;
        }>
      ).map((row) => ({
        source: row.source,
        value: row.value,
        formatted_message: row.formatted_message,
        posted_at: row.posted_at,
        nearest_match_distance: null,
        matched_source: null,
        matched_formatted_message: null,
        matched_posted_at: null,
      }));

  return {
    snapshotVersion: etag,
    sources: sources.map((row) => ({
      name: row.name,
      lastValue: row.last_value,
      lastFetchedAt: row.last_fetched_at,
      lastPostedAt: row.last_posted_at,
    })),
    recentNotifications: notifications.map((row) => ({
      source: row.source,
      value: row.value,
      formattedMessage: row.formatted_message,
      postedAt: row.posted_at,
      // Guard on every dependent column being non-null, not just `matched_source`.
      // `nearest_match_distance` is written separately from `nearest_match_id` in
      // `runFetch`, so a partial-write row (or one whose matched row was deleted
      // out from under the unenforced FK) can have the join columns populated but
      // the distance null — emitting `distance: null` against a `number` type would
      // be a silent lie. Treat any missing component as "no match to show," the
      // same null outcome the user sees on a first-ever notification.
      nearestMatch:
        row.matched_source !== null &&
        row.matched_formatted_message !== null &&
        row.matched_posted_at !== null &&
        row.nearest_match_distance !== null
          ? {
              source: row.matched_source,
              formattedMessage: row.matched_formatted_message,
              postedAt: row.matched_posted_at,
              distance: row.nearest_match_distance,
            }
          : null,
    })),
  };
}

/**
 * Creates a reader instance holding module-scope hydration state (spec §4.3): the last
 * hydrated ETag and an open read-only handle. Call `getStatus` on every invocation; the
 * instance itself must be created once per Lambda container (module scope in
 * `src/handler.ts`), not per request — recreating it would defeat the version cache.
 */
export function createStatusReader(dbPath: string): StatusReader {
  const state: ReaderState = { cachedEtag: null, db: undefined };

  return {
    async getStatus(store: Store, storeKey: string): Promise<StatusResult> {
      const head = await store.head(storeKey);

      // No snapshot yet — fetch has never run successfully (spec §4.3). Nothing to query.
      if (head === null) {
        return { snapshotVersion: null, sources: [], recentNotifications: [] };
      }

      const cacheHit = state.cachedEtag === head.etag && state.db !== undefined && existsSync(dbPath);

      if (!cacheHit) {
        // `better-sqlite3` keeps a page cache in memory; if the file on disk changes
        // underneath an open handle, the cache describes a file that no longer exists —
        // silently wrong answers, no error. Close before overwriting (spec §4.3).
        // Clear both fields together so a partial failure (rmSync, store.get, write,
        // openReadOnlyDatabase throwing) leaves the cache in the empty-cache state
        // `(null, undefined)` rather than the invalid `(oldEtag, undefined)`. Only the
        // successful open at the end of this branch restores the populated state.
        if (state.db !== undefined) {
          state.db.close();
        }
        state.db = undefined;
        state.cachedEtag = null;
        // `force: true` makes the delete robust against the file disappearing between the
        // existsSync check and the rmSync call — `/tmp` is shared with the writer, and
        // `/tmp` cleanup can race us too. With `force` the no-op case is harmless.
        rmSync(dbPath, { force: true });

        const object = await store.get(storeKey);
        if (object === null) {
          // HEAD succeeded but GET raced a delete between the two calls — treat as
          // no-snapshot rather than throwing, since the outcome the caller cares about
          // (nothing to query) is identical to the head === null branch above. cachedEtag
          // was already cleared at the top of this branch, so the next call retries the
          // full cache-miss path from a known-empty state (spec §4.3.1).
          return { snapshotVersion: null, sources: [], recentNotifications: [] };
        }

        writeFileSync(dbPath, object.body);
        // Assign cachedEtag only after openReadOnlyDatabase succeeds — any throw between
        // here and the top of the branch (rmSync, store.get, writeFileSync, open) leaves
        // the cache in `(null, undefined)` per spec §4.3.1.
        state.db = openReadOnlyDatabase(dbPath);
        state.cachedEtag = object.etag;
      }

      return queryStatus(state.db as Database.Database, state.cachedEtag as string);
    },
    __peekReaderState() {
      return { cachedEtag: state.cachedEtag, dbIsOpen: state.db !== undefined };
    },
  };
}