import type Database from 'better-sqlite3';
import { AGENT_DDL } from './schema.js';

/** Creates the three agent tables. Idempotent — safe to call on every writer invocation. */
export function bootstrap(db: Database.Database): void {
  db.exec(AGENT_DDL);
}
