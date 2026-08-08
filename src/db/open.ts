import Database from 'better-sqlite3';

/**
 * Opens a file-backed SQLite database.
 *
 * DELETE journal mode, not WAL: the durable store is a single S3 object containing only
 * `memory.db` (spec §3.1 step 2). WAL keeps committed data in a sidecar `-wal` file, which
 * would make an S3 upload of `memory.db` alone silently omit the most recent writes.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  return db;
}
