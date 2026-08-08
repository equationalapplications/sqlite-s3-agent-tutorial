import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { bootstrap } from '../db/bootstrap.js';
import { openDatabase } from '../db/open.js';
import type { DiscordPoster } from '../discord/poster.js';
import type { MessageFormatter } from '../format/types.js';
import type { SourceFetcher } from '../sources/types.js';
import type { Store } from '../store/types.js';
import { finishRun, startRun } from './runLog.js';

export interface RunFetchParams {
  dbPath: string;
  store: Store;
  storeKey: string;
  sources: SourceFetcher[];
  poster: DiscordPoster;
  formatter: MessageFormatter;
  runId?: string;
  now?: () => number;
}

export interface RunFetchResult {
  outcome: 'success' | 'error';
  sourcesChecked: number;
  notificationsSent: number;
  error: string | null;
}

/**
 * The writer op (spec §3.1). Hydrates from the store, runs bootstrap, checks each
 * configured source for a new value, formats and posts on change, records the run, and
 * publishes the updated snapshot back to the store with a conditional write.
 *
 * Per-source failures (fetch, formatter, or Discord post) are caught individually and
 * folded into `agent_runs.error`; the run still completes and outcome stays `'success'`
 * (spec §6). Only a `PreconditionFailedError` from the final publish propagates — that is
 * an abort, not a per-source failure (spec §4.2).
 */
export async function runFetch(params: RunFetchParams): Promise<RunFetchResult> {
  const runId = params.runId ?? randomUUID();
  const now = params.now ?? (() => Date.now());

  // Step 1: hydrate.
  const existing = await params.store.get(params.storeKey);
  if (existing !== null) {
    writeFileSync(params.dbPath, existing.body);
  }
  const priorEtag: string | null = existing?.etag ?? null;

  // Step 2-3: open and bootstrap. Bootstrap is idempotent, so this is correct whether the
  // file was just hydrated or is a fresh empty file (spec §4.1).
  const db: Database.Database = openDatabase(params.dbPath);
  bootstrap(db);

  // Step 4: start the run record.
  startRun(db, {
    runId,
    op: 'fetch',
    snapshotVersionIn: priorEtag ?? 'none',
    startedAt: now(),
  });

  const errors: string[] = [];
  let notificationsSent = 0;

  // Step 5: per-source loop.
  for (const source of params.sources) {
    try {
      const rawValue = await source.fetch();

      const existingRow = db
        .prepare(`SELECT last_value FROM agent_sources WHERE name = ?`)
        .get(source.name) as { last_value: string | null } | undefined;
      const lastValue = existingRow?.last_value ?? null;

      if (rawValue === lastValue) {
        continue; // dedup: no formatter call, no post, no notification row
      }

      const formatted = await params.formatter.format(source.name, rawValue);
      await params.poster.post(formatted);

      const postedAt = now();
      // Insert into agent_sources first — agent_notifications has a FK on source, so a
      // notifications insert on a brand-new source would violate the constraint.
      db.prepare(
        `INSERT INTO agent_sources (name, last_value, last_fetched_at, last_posted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           last_value = excluded.last_value,
           last_fetched_at = excluded.last_fetched_at,
           last_posted_at = excluded.last_posted_at`,
      ).run(source.name, rawValue, postedAt, postedAt);

      db.prepare(
        `INSERT INTO agent_notifications (source, value, formatted_message, posted_at)
         VALUES (?, ?, ?, ?)`,
      ).run(source.name, rawValue, formatted, postedAt);

      notificationsSent++;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    }
  }

  // Step 6: finish the run record.
  const errorText = errors.length > 0 ? errors.join('; ') : null;
  finishRun(db, {
    runId,
    endedAt: now(),
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent,
    error: errorText,
  });

  db.close();

  // Step 7: conditional publish. A PreconditionFailedError here is an abort, not a
  // per-source failure (spec §4.2) — the run row is updated to outcome: 'error' before
  // the error propagates, so the abort is visible in agent_runs even though the snapshot
  // holding that row was never uploaded.
  const body = readFileSync(params.dbPath);
  try {
    await params.store.put(params.storeKey, body, priorEtag);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const dbForFailure = openDatabase(params.dbPath);
    finishRun(dbForFailure, {
      runId,
      endedAt: now(),
      outcome: 'error',
      sourcesChecked: params.sources.length,
      notificationsSent,
      error: errorText === null ? message : `${errorText}; ${message}`,
    });
    dbForFailure.close();
    throw error;
  }

  return {
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent,
    error: errorText,
  };
}
