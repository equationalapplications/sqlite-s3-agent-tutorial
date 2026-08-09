import type Database from 'better-sqlite3';

/** A match found by `findNearestMatch` — the past tick's pre-suffix output (the LLM's
 *  clean message, never its `formatted_message`). The writer uses `baseMessage` to
 *  build the "Reminds me of" suffix; using `formattedMessage` instead would let the
 *  suffix grow recursively and eventually blow the Discord 2000-char limit (loop-mode
 *  + poetic-closing spec §1, §4.5). */
export interface NearestMatch {
  notificationId: number;
  distance: number;
  baseMessage: string;
  postedAt: number;
}

/**
 * Fixed KNN scan size (loop-mode + poetic-closing spec §4.5). At 5-min cadence, 2 sources,
 * 1 row per source per tick, 50 candidates is roughly 2 hours of wall-clock history —
 * a generous window for the loop's intended short-lived test runs (5–10 minutes), so the
 * ceiling is unlikely to bind in practice. Past this ceiling, `findNearestMatch` can miss
 * the true nearest neighbor if it isn't among the 50 closest across `agent_embeddings`.
 * Same pattern as `RECENT_NOTIFICATIONS_LIMIT` in `src/agent/status.ts`.
 */
const KNN_CANDIDATES = 50;

interface CandidateRow {
  notificationId: number;
  baseMessage: string;
  postedAt: number;
  distance: number;
}

/**
 * Finds the closest past notification to `queryVector` across all sources (global KNN,
 * no per-source filter), or `null` if no eligible history exists. The `agent_embeddings`
 * table is shared across sources (RAG design spec §3.1).
 *
 * `WHERE n.base_message IS NOT NULL` is applied as a post-filter on the top-`k`
 * candidates — `sqlite-vec`'s `k` parameter operates on the raw vector scan, so this
 * filter runs after the KNN. It is required: without it, legacy rows (post-migration
 * `base_message = NULL`) would surface as `agent_embeddings` candidates whose joined
 * `base_message` is null, and the writer would post the literal string `"null"` into
 * the "Reminds me of" suffix.
 *
 * Step-ordering note: this scan runs *before* the current tick's `insertEmbedding` (which
 * happens after the Discord post in `runFetch`), so the corpus at query time contains
 * only notifications already posted by prior ticks. The current tick's own message
 * cannot be its own match — no explicit age floor is needed to enforce that.
 */
export function findNearestMatch(db: Database.Database, queryVector: number[]): NearestMatch | null {
  const rows = db
    .prepare(
      `SELECT n.id AS notificationId, n.base_message AS baseMessage,
              n.posted_at AS postedAt, e.distance AS distance FROM agent_embeddings e
       JOIN agent_notifications n ON n.id = e.notification_id
       WHERE e.embedding MATCH ? AND k = ?
         AND n.base_message IS NOT NULL
       ORDER BY e.distance`,
    )
    .all(JSON.stringify(queryVector), KNN_CANDIDATES) as CandidateRow[];

  const match = rows[0];
  if (match === undefined) return null;

  return {
    notificationId: match.notificationId,
    distance: match.distance,
    baseMessage: match.baseMessage,
    postedAt: match.postedAt,
  };
}

/** Stores `vector` for `notificationId`, making it a future `findNearestMatch`
 *  candidate. Called once per posted notification (RAG design spec §3.1).
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
