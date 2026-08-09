import type Database from 'better-sqlite3';
import type { SourceName } from '../db/schema.js';

export interface NearestMatch {
  notificationId: number;
  distance: number;
  formattedMessage: string;
  postedAt: number;
}

/**
 * Fixed KNN scan size (RAG design spec §4.2) — generous for a once-daily tutorial's
 * history (50 rows is ~7 weeks across two sources), documented as a known ceiling rather
 * than engineered for arbitrary scale: past this ceiling, `findNearestMatch` can miss the
 * true nearest same-source neighbor if it isn't among the 50 closest across *all*
 * sources. Same pattern as `RECENT_NOTIFICATIONS_LIMIT` in `src/agent/status.ts`.
 */
const KNN_CANDIDATES = 50;

interface CandidateRow {
  notificationId: number;
  source: string;
  formattedMessage: string;
  postedAt: number;
  distance: number;
}

/**
 * Finds the closest same-source past notification to `queryVector`, or `null` if the
 * source has no embedded history yet. `agent_embeddings` is a single table across all
 * sources (RAG design spec §3.1) — same-source filtering happens here, in application
 * code, rather than via a `sqlite-vec` partition key, to avoid depending on a
 * less-battle-tested part of the extension's API for this tutorial (spec §4.2, §11).
 */
export function findNearestMatch(db: Database.Database, source: SourceName, queryVector: number[]): NearestMatch | null {
  const rows = db
    .prepare(
      `SELECT n.id AS notificationId, n.source AS source, n.formatted_message AS formattedMessage,
              n.posted_at AS postedAt, e.distance AS distance
       FROM agent_embeddings e
       JOIN agent_notifications n ON n.id = e.notification_id
       WHERE e.embedding MATCH ? AND k = ?
       ORDER BY e.distance`,
    )
    .all(JSON.stringify(queryVector), KNN_CANDIDATES) as CandidateRow[];

  const match = rows.find((row) => row.source === source);
  if (match === undefined) return null;

  return {
    notificationId: match.notificationId,
    distance: match.distance,
    formattedMessage: match.formattedMessage,
    postedAt: match.postedAt,
  };
}

/** Stores `vector` for `notificationId`, making it a future `findNearestMatch`
 *  candidate. Called once per posted notification (RAG design spec §3.1) — never for
 *  deduped/unchanged values.
 *
 *  `notificationId` must be bound as a `BigInt`: binding it as a plain JS number trips
 *  `vec0`'s "Only integers are allowed for primary key values" check in `better-sqlite3`
 *  (verified against installed sqlite-vec v0.1.9 + better-sqlite3 v13 — the same literal
 *  value works fine via `db.exec` with an inlined integer, so this is specific to bound
 *  parameters on this virtual table, not a general integer-vs-float issue). */
export function insertEmbedding(db: Database.Database, notificationId: number, vector: number[]): void {
  db.prepare(`INSERT INTO agent_embeddings (notification_id, embedding) VALUES (?, vec_f32(?))`).run(
    BigInt(notificationId),
    JSON.stringify(vector),
  );
}
