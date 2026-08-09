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
  /** The closest same-source past notification at the time this one was posted (RAG
   *  design spec §7), or `null` if this was the source's first-ever notification, or the
   *  RAG lookup failed and was isolated (spec §6) — the two cases are indistinguishable
   *  here on purpose, since neither has a match to show. Populated once, at write time,
   *  by `runFetch`; this module never runs a vector query itself. */
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

function queryStatus(db: Database.Database, etag: string): StatusResult {
  // ORDER BY name keeps the sources list deterministic across SQLite versions and
  // vacuuming — without it, SQL does not guarantee row order.
  const sources = db
    .prepare(`SELECT name, last_value, last_fetched_at, last_posted_at FROM agent_sources ORDER BY name`)
    .all() as Array<{ name: string; last_value: string | null; last_fetched_at: number | null; last_posted_at: number | null }>;

  // id DESC is a tie-breaker for notifications that share the same posted_at — without
  // it, the LIMIT picks an arbitrary subset and the endpoint output is not stable. The
  // LEFT JOIN pulls the matched notification's own source/message/postedAt so the status
  // endpoint is self-contained — no vector search happens here, only a second read of
  // already-open agent_notifications (RAG design spec §7).
  const notifications = db
    .prepare(
      `SELECT n.source, n.value, n.formatted_message, n.posted_at, n.nearest_match_distance,
              m.source AS matched_source, m.formatted_message AS matched_formatted_message,
              m.posted_at AS matched_posted_at
       FROM agent_notifications n
       LEFT JOIN agent_notifications m ON m.id = n.nearest_match_id
       ORDER BY n.posted_at DESC, n.id DESC LIMIT ?`,
    )
    .all(RECENT_NOTIFICATIONS_LIMIT) as Array<{
    source: string;
    value: string;
    formatted_message: string;
    posted_at: number;
    nearest_match_distance: number | null;
    matched_source: string | null;
    matched_formatted_message: string | null;
    matched_posted_at: number | null;
  }>;

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
      nearestMatch:
        row.matched_source === null
          ? null
          : {
              source: row.matched_source,
              formattedMessage: row.matched_formatted_message as string,
              postedAt: row.matched_posted_at as number,
              distance: row.nearest_match_distance as number,
            },
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