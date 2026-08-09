import type Database from 'better-sqlite3';
import { AGENT_DDL } from './schema.js';

/** Creates the three agent tables plus `agent_embeddings`. Idempotent — safe to call on
 *  every writer invocation. */
export function bootstrap(db: Database.Database): void {
  db.exec(AGENT_DDL);
  addMissingColumns(db);
}

/**
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so idempotency is
 * implemented by checking `PRAGMA table_info` first. These columns record the
 * past-notification relationship at the time this notification was posted:
 *
 * - `nearest_match_id` / `nearest_match_distance` — RAG design spec §3.2
 * - `base_message` — loop-mode + poetic-closing design spec §3. Stores the LLM's
 *   pre-suffix output (the friendly comment + haiku). The RAG corpus embeds this
 *   column, and `findNearestMatch` returns it for the "Reminds me of" suffix —
 *   never the posted `formatted_message` — so the suffix cannot snowball.
 *   Nullable so legacy rows post-migration carry `NULL` and the `IS NOT NULL`
 *   filter in `findNearestMatch` keeps them out of match candidacy.
 */
function addMissingColumns(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(agent_notifications)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has('nearest_match_id')) {
    db.exec(
      `ALTER TABLE agent_notifications ADD COLUMN nearest_match_id INTEGER REFERENCES agent_notifications(id)`,
    );
  }
  if (!names.has('nearest_match_distance')) {
    db.exec(`ALTER TABLE agent_notifications ADD COLUMN nearest_match_distance REAL`);
  }
  if (!names.has('base_message')) {
    db.exec(`ALTER TABLE agent_notifications ADD COLUMN base_message TEXT`);
  }
}
