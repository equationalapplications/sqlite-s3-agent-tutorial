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
}

function queryStatus(db: Database.Database, etag: string): StatusResult {
  // ORDER BY name keeps the sources list deterministic across SQLite versions and
  // vacuuming — without it, SQL does not guarantee row order.
  const sources = db
    .prepare(`SELECT name, last_value, last_fetched_at, last_posted_at FROM agent_sources ORDER BY name`)
    .all() as Array<{ name: string; last_value: string | null; last_fetched_at: number | null; last_posted_at: number | null }>;

  // id DESC is a tie-breaker for notifications that share the same posted_at — without
  // it, the LIMIT picks an arbitrary subset and the endpoint output is not stable.
  const notifications = db
    .prepare(
      `SELECT source, value, formatted_message, posted_at FROM agent_notifications
       ORDER BY posted_at DESC, id DESC LIMIT ?`,
    )
    .all(RECENT_NOTIFICATIONS_LIMIT) as Array<{
    source: string;
    value: string;
    formatted_message: string;
    posted_at: number;
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
        if (state.db !== undefined) {
          state.db.close();
          state.db = undefined;
        }
        // `force: true` makes the delete robust against the file disappearing between the
        // existsSync check and the rmSync call — `/tmp` is shared with the writer, and
        // `/tmp` cleanup can race us too. With `force` the no-op case is harmless.
        rmSync(dbPath, { force: true });

        const object = await store.get(storeKey);
        if (object === null) {
          // HEAD succeeded but GET raced a delete between the two calls — treat as
          // no-snapshot rather than throwing, since the outcome the caller cares about
          // (nothing to query) is identical to the head === null branch above.
          return { snapshotVersion: null, sources: [], recentNotifications: [] };
        }

        writeFileSync(dbPath, object.body);
        state.cachedEtag = object.etag;
        state.db = openReadOnlyDatabase(dbPath);
      }

      return queryStatus(state.db as Database.Database, state.cachedEtag as string);
    },
  };
}