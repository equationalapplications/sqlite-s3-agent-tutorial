// tests/db.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase, openReadOnlyDatabase } from '../src/db/open.js';
import { AGENT_DDL, SOURCE_NAMES } from '../src/db/schema.js';

/** AGENT_DDL now includes a `vec0` virtual table, so any raw `new Database()` instance
 *  in this file needs the extension loaded before `db.exec(AGENT_DDL)` — `openDatabase`
 *  does this for production code, but these tests bypass `openDatabase` on purpose to
 *  test the DDL in isolation. */
function newDbWithVec(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  return db;
}

describe('schema DDL', () => {
  it('creates all three tables plus the agent_embeddings vector table', () => {
    const db = newDbWithVec();
    db.exec(AGENT_DDL);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('agent_sources');
    expect(names).toContain('agent_notifications');
    expect(names).toContain('agent_runs');
    expect(names).toContain('agent_embeddings');
    db.close();
  });

  it('rejects a source name outside the closed vocabulary', () => {
    const db = newDbWithVec();
    db.exec(AGENT_DDL);

    expect(() =>
      db
        .prepare(`INSERT INTO agent_sources (name) VALUES (?)`)
        .run('wether'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('accepts every name in the closed vocabulary', () => {
    const db = newDbWithVec();
    db.exec(AGENT_DDL);

    for (const name of SOURCE_NAMES) {
      expect(() =>
        db.prepare(`INSERT INTO agent_sources (name) VALUES (?)`).run(name),
      ).not.toThrow();
    }
    db.close();
  });

  it('agent_embeddings accepts a 256-dim float vector keyed by notification_id', () => {
    const db = newDbWithVec();
    db.exec(AGENT_DDL);
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();
    const notificationId = db
      .prepare(
        `INSERT INTO agent_notifications (source, value, formatted_message, posted_at)
         VALUES ('weather', '72F', 'Weather update: 72F', 1000)`,
      )
      .run().lastInsertRowid as number;

    const vector = JSON.stringify(new Array(256).fill(0.1));
    // notification_id must be bound as a BigInt: better-sqlite3 binding a plain JS
    // number as the primary key of a vec0 virtual table's INSERT trips sqlite-vec's
    // "Only integers are allowed for primary key values" check, even though the same
    // number works fine as a rowid on an ordinary table (verified against installed
    // sqlite-vec v0.1.9 + better-sqlite3 v13 before writing this).
    expect(() =>
      db
        .prepare(`INSERT INTO agent_embeddings (notification_id, embedding) VALUES (?, vec_f32(?))`)
        .run(BigInt(notificationId), vector),
    ).not.toThrow();

    const row = db.prepare(`SELECT notification_id FROM agent_embeddings`).get() as { notification_id: number };
    expect(row.notification_id).toBe(notificationId);
    db.close();
  });
});

describe('bootstrap', () => {
  it('is idempotent — running twice on an empty DB causes no schema errors or data loss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const db = openDatabase(path);
    bootstrap(db);
    db.prepare(
      `INSERT INTO agent_sources (name, last_value) VALUES ('weather', '72F')`,
    ).run();

    bootstrap(db); // second call must not error or wipe the row just inserted

    const row = db
      .prepare(`SELECT last_value FROM agent_sources WHERE name = 'weather'`)
      .get() as { last_value: string } | undefined;
    expect(row?.last_value).toBe('72F');

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('openDatabase', () => {
  it('opens a file-backed database in DELETE journal mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const db = openDatabase(path);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('delete');

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enables foreign keys per connection (agent_notifications.source FK enforced)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const db = openDatabase(path);
    bootstrap(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    // Inserting a notification for a source that doesn't exist in agent_sources must
    // fail with a FOREIGN KEY constraint violation — not silently succeed.
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_notifications (source, value, formatted_message, posted_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('weather', '72F', 'Weather update: 72F', 1000),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the sqlite-vec extension so vec0 tables can be created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const db = openDatabase(path);
    expect(() =>
      db.exec(`CREATE VIRTUAL TABLE probe_vec USING vec0(embedding FLOAT[4])`),
    ).not.toThrow();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('openReadOnlyDatabase', () => {
  it('opens an existing file without allowing writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const writable = openDatabase(path);
    bootstrap(writable);
    writable.close();

    const readOnly = openReadOnlyDatabase(path);
    expect(() =>
      readOnly.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run(),
    ).toThrow(/readonly/i);

    readOnly.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('bootstrap — nearest_match columns', () => {
  it('adds nearest_match_id and nearest_match_distance to agent_notifications', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const db = openDatabase(path);
    bootstrap(db);

    const columns = db.prepare(`PRAGMA table_info(agent_notifications)`).all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('nearest_match_id');
    expect(names).toContain('nearest_match_distance');

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent — running bootstrap twice does not error or duplicate the columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const db = openDatabase(path);
    bootstrap(db);
    bootstrap(db); // second call must not throw "duplicate column name"

    const columns = db.prepare(`PRAGMA table_info(agent_notifications)`).all() as Array<{ name: string }>;
    const nearestMatchIdCount = columns.filter((c) => c.name === 'nearest_match_id').length;
    expect(nearestMatchIdCount).toBe(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds base_message to agent_notifications when missing, and is idempotent on re-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const db = openDatabase(path);
    bootstrap(db);

    // After bootstrap, base_message column exists and is nullable.
    const cols = db.prepare(`PRAGMA table_info(agent_notifications)`).all() as Array<{ name: string; notnull: number }>;
    const base = cols.find((c) => c.name === 'base_message');
    expect(base).toBeDefined();
    expect(base?.notnull).toBe(0);

    // Inserting a row with base_message = null is allowed (legacy rows post-migration).
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();
    db.prepare(
      `INSERT INTO agent_notifications (source, value, formatted_message, posted_at, base_message)
       VALUES ('weather', 'v', 'msg', 1000, NULL)`,
    ).run();

    // Re-running bootstrap must not throw and must not alter the column.
    expect(() => bootstrap(db)).not.toThrow();
    const colsAfter = db.prepare(`PRAGMA table_info(agent_notifications)`).all() as Array<{ name: string }>;
    expect(colsAfter.filter((c) => c.name === 'base_message')).toHaveLength(1);

    // The legacy row (inserted with base_message = NULL above) must survive the
    // second bootstrap unchanged — this pins data preservation, not only schema shape.
    const legacy = db
      .prepare(`SELECT base_message FROM agent_notifications`)
      .all() as Array<{ base_message: string | null }>;
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.base_message).toBeNull();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
