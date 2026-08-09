import Database from 'better-sqlite3';

/**
 * Opens a file-backed SQLite database.
 *
 * DELETE journal mode, not WAL: the durable store is a single S3 object containing only
 * `memory.db` (spec §3.1 step 2). WAL keeps committed data in a sidecar `-wal` file, which
 * would make an S3 upload of `memory.db` alone silently omit the most recent writes.
 *
 * Foreign keys are enabled per connection (SQLite default is off). Without this,
 * `agent_notifications.source`'s `FOREIGN KEY ... ON DELETE CASCADE` is a no-op, and the
 * writer could insert orphan notification rows for sources that don't exist in
 * `agent_sources`.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Opens an existing SQLite file read-only. Used by the reader (spec §3.2): the reader's
 * IAM grant is GetObject-only (spec §2), so a read-only DB handle matches that intent even
 * though `better-sqlite3` itself has no knowledge of the S3 permission model.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true });
}
