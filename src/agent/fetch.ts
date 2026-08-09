import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { bootstrap } from '../db/bootstrap.js';
import { openDatabase } from '../db/open.js';
import type { Embedder } from '../embed/titan.js';
import type { DiscordPoster } from '../discord/poster.js';
import type { LoopContext, MessageFormatter } from '../format/types.js';
import { findNearestMatch, insertEmbedding } from '../rag/similarity.js';
import type { SourceFetcher, SourceName } from '../sources/types.js';
import type { Store } from '../store/types.js';
import { finishRun, startRun } from './runLog.js';

export interface RunFetchParams {
  dbPath: string;
  store: Store;
  storeKey: string;
  sources: SourceFetcher[];
  poster: DiscordPoster;
  formatter: MessageFormatter;
  embedder: Embedder;
  /** The configured location (e.g. "NYC") — passed through to the `LoopContext` so the
   *  LLM can weave it into the friendly comment and haiku. Loop-mode + poetic-closing
   *  spec §4.4. */
  weatherLocation: string;
  runId?: string;
  now?: () => number;
}

export interface RunFetchResult {
  outcome: 'success' | 'error';
  sourcesChecked: number;
  notificationsSent: number;
  error: string | null;
}

/** Discord's hard cap on webhook message content. A webhook POST with a `content`
 *  field over this length is rejected with a 400 before notification/embedding
 *  persistence — so the writer must bound the final message here, not at the poster.
 *  See https://docs.discord.com/developers/resources/webhook#execute-webhook. */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

const REMINDS_ME_OF_SEPARATOR = '\n\nReminds me of: ';
const SUFFIX_TRUNCATION_MARKER = '...';

/**
 * Builds the message posted to Discord from the LLM's pre-suffix output and the
 * optional RAG match. Enforces Discord's 2000-character hard cap so a malformed
 * LLM output or an unexpectedly long past `base_message` cannot cause Discord to
 * reject the post before the notification/embedding persistence step.
 *
 * Rules:
 *  - If `preMessage` is longer than the cap on its own, truncate it and return
 *    (no suffix — the preMessage cannot be preserved once it doesn't fit).
 *  - If the full suffix (`"\n\nReminds me of: <baseMessage>"`) fits, use it whole.
 *  - If the suffix does not fit but there is room for at least a clipped version,
 *    truncate `baseMessage` to fit and append `...` as a clip marker.
 *  - If there is not even room for the separator, omit the suffix entirely.
 */
export function buildFinalMessageForDiscord(
  preMessage: string,
  baseMessage: string | null,
  limit: number = DISCORD_MAX_MESSAGE_CHARS,
): string {
  if (preMessage.length > limit) {
    return preMessage.slice(0, limit);
  }
  if (baseMessage === null) {
    return preMessage;
  }
  const fullSuffix = REMINDS_ME_OF_SEPARATOR + baseMessage;
  if (preMessage.length + fullSuffix.length <= limit) {
    return preMessage + fullSuffix;
  }
  // Need to clip the suffix. Room available for the entire suffix line.
  const room = limit - preMessage.length;
  // No room for even the separator + clip marker — drop the suffix entirely.
  if (room < REMINDS_ME_OF_SEPARATOR.length + SUFFIX_TRUNCATION_MARKER.length) {
    return preMessage;
  }
  const clippedBase =
    room - REMINDS_ME_OF_SEPARATOR.length - SUFFIX_TRUNCATION_MARKER.length;
  return preMessage + REMINDS_ME_OF_SEPARATOR + baseMessage.slice(0, clippedBase) + SUFFIX_TRUNCATION_MARKER;
}

/**
 * The writer op (spec §3.1, loop-mode + poetic-closing spec §4.4). Hydrates from the
 * store, runs bootstrap, fetches every source, formats ONCE with a `LoopContext`,
 * embeds the LLM's pre-suffix output ONCE, runs a global KNN lookup, appends a
 * mechanical "Reminds me of" suffix if a match exists, posts ONCE, writes per-source
 * `agent_notifications` rows (each with the same combined `formatted_message` /
 * `base_message` / `nearest_match_id`), reuses the pre-vector to insert per-source
 * embeddings, and publishes the snapshot back with a conditional write.
 *
 * Per-source failures (fetch only — there is no per-source formatter or post)
 * are caught individually and folded into `agent_runs.error`; the run still completes
 * and outcome stays `'success'`. Tick-level failures (formatter, embed, post) are
 * caught and the rest of the tick is skipped. Only a `PreconditionFailedError` from
 * the final publish propagates — that is an abort, not a tick-level failure.
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

  // Step 5: per-source fetch. Per-source failures are caught individually; the live
  // readings feed step 7's LoopContext.
  const readings = new Map<SourceName, string>();
  for (const source of params.sources) {
    try {
      readings.set(source.name, await source.fetch());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    }
  }

  // Step 6: if every source failed, the rest of the tick is a no-op.
  if (readings.size === 0) {
    finishRun(db, {
      runId,
      endedAt: now(),
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; ') || null,
    });
    db.close();

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
        notificationsSent: 0,
        error: errors.length > 0 ? `${errors.join('; ')}; ${message}` : message,
      });
      dbForFailure.close();
      throw error;
    }

    return {
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; ') || null,
    };
  }

  // Step 7: build LoopContext and format ONCE (no RAG fields). A formatter failure
  // skips the rest of the tick.
  const loopContext: LoopContext = {
    date: new Date(now()).toISOString().slice(0, 10),
    location: params.weatherLocation,
    readings: [...readings.entries()].map(([source, value]) => ({ source, value })),
  };

  let preMessage: string;
  try {
    preMessage = await params.formatter.format(loopContext);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`formatter: ${message}`);
    finishRun(db, {
      runId,
      endedAt: now(),
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; '),
    });
    return publish(db, params, priorEtag, runId, now, 0, errors);
  }

  // Step 8: two-step RAG. Embed the LLM's pre-suffix output ONCE for the tick, then
  // run a global KNN lookup. A failure here skips the suffix but keeps the post.
  let preVector: number[] | null = null;
  type RAGMatch = { notificationId: number; distance: number; baseMessage: string; postedAt: number };
  let match: RAGMatch | null = null;
  try {
    preVector = await params.embedder.embed(preMessage);
    match = findNearestMatch(db, preVector);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`rag: ${message}`);
    // preVector stays null — step 13's embedding insert is skipped for this tick.
  }

  // Step 9: build the final message. The suffix is built from past base_message
  // (never past formatted_message), so the chain cannot snowball. The result is
  // bounded to Discord's 2000-character webhook cap via `buildFinalMessageForDiscord`
  // — without that guard, an oversized preMessage or past baseMessage would cause
  // Discord to reject the post before this tick's notification/embedding writes.
  const finalMessage = buildFinalMessageForDiscord(
    preMessage,
    match === null ? null : match.baseMessage,
  );

  // Step 10: post once.
  try {
    await params.poster.post(finalMessage);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`post: ${message}`);
    finishRun(db, {
      runId,
      endedAt: now(),
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; '),
    });
    return publish(db, params, priorEtag, runId, now, 0, errors);
  }

  // Step 11: per-source DB writes. agent_sources must be upserted BEFORE
  // agent_notifications, because the latter has a FK on the former.
  const postedAt = now();
  for (const [sourceName, value] of readings) {
    db.prepare(
      `INSERT INTO agent_sources (name, last_value, last_fetched_at, last_posted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_value = excluded.last_value,
         last_fetched_at = excluded.last_fetched_at,
         last_posted_at = excluded.last_posted_at`,
    ).run(sourceName, value, postedAt, postedAt);

    const insertResult = db
      .prepare(
        `INSERT INTO agent_notifications
           (source, value, formatted_message, base_message, posted_at,
            nearest_match_id, nearest_match_distance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceName,
        value,
        finalMessage,
        preMessage,
        postedAt,
        match?.notificationId ?? null,
        match?.distance ?? null,
      );

    // Step 12: per-source embedding insert. Reuses preVector — no second Titan call.
    // Per-source insert failures are caught individually so the notification row
    // committed in step 11 stays.
    if (preVector !== null) {
      try {
        insertEmbedding(db, Number(insertResult.lastInsertRowid), preVector);
      } catch (storeError: unknown) {
        const message = storeError instanceof Error ? storeError.message : String(storeError);
        errors.push(`${sourceName} (embedding store): ${message}`);
      }
    }
  }

  // Step 13: finish the run record. One combined post per tick, regardless of how many
  // sources contributed.
  const errorText = errors.length > 0 ? errors.join('; ') : null;
  finishRun(db, {
    runId,
    endedAt: now(),
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent: 1,
    error: errorText,
  });

  db.close();

  // Step 14: conditional publish. A PreconditionFailedError here is an abort, not a
  // tick-level failure (spec §4.2).
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
      notificationsSent: 1,
      error: errorText === null ? message : `${errorText}; ${message}`,
    });
    dbForFailure.close();
    throw error;
  }

  return {
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent: 1,
    error: errorText,
  };
}

/**
 * Short-circuits the publish step for tick-level failures — closes the passed-in DB,
 * publishes the snapshot, and returns the standard RunFetchResult. On a publish
 * failure it reopens the DB to record the run as failed before re-throwing. The
 * early-return paths in `runFetch` use this so the conditional-publish logic only
 * lives in one place. The caller must NOT close `db` before calling — this helper
 * owns the close.
 */
function publish(
  db: Database.Database,
  params: RunFetchParams,
  priorEtag: string | null,
  runId: string,
  now: () => number,
  notificationsSent: number,
  errors: string[],
): Promise<RunFetchResult> {
  db.close();
  const body = readFileSync(params.dbPath);
  return params.store
    .put(params.storeKey, body, priorEtag)
    .then(() => ({
      outcome: 'success' as const,
      sourcesChecked: params.sources.length,
      notificationsSent,
      error: errors.length > 0 ? errors.join('; ') : null,
    }))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const dbForFailure = openDatabase(params.dbPath);
      finishRun(dbForFailure, {
        runId,
        endedAt: now(),
        outcome: 'error',
        sourcesChecked: params.sources.length,
        notificationsSent,
        error: errors.length > 0 ? `${errors.join('; ')}; ${message}` : message,
      });
      dbForFailure.close();
      throw error;
    });
}
