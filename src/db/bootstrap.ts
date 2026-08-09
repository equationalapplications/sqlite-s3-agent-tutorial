import type Database from 'better-sqlite3';
import { AGENT_DDL } from './schema.js';

/** Creates the three agent tables plus `agent_embeddings`. Idempotent — safe to call on
 *  every writer invocation. */
export function bootstrap(db: Database.Database): void {
  db.exec(AGENT_DDL);
  addNearestMatchColumnsIfMissing(db);
}

/**
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so idempotency here is
 * implemented by checking `PRAGMA table_info` first. These two columns record which
 * past notification (if any) was the closest match at the time this notification was
 * posted (RAG design spec §3.2) — both nullable, since `NULL` legitimately means "no
 * prior notification for this source yet" or "the embedding/match step failed and was
 * isolated" (spec §6), not a placeholder to special-case.
 */
function addNearestMatchColumnsIfMissing(db: Database.Database): void {
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
}
