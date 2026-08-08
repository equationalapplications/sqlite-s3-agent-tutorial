// tests/db.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase, openReadOnlyDatabase } from '../src/db/open.js';
import { AGENT_DDL, SOURCE_NAMES } from '../src/db/schema.js';

describe('schema DDL', () => {
  it('creates all three tables', () => {
    const db = new Database(':memory:');
    db.exec(AGENT_DDL);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('agent_sources');
    expect(names).toContain('agent_notifications');
    expect(names).toContain('agent_runs');
    db.close();
  });

  it('rejects a source name outside the closed vocabulary', () => {
    const db = new Database(':memory:');
    db.exec(AGENT_DDL);

    expect(() =>
      db
        .prepare(`INSERT INTO agent_sources (name) VALUES (?)`)
        .run('wether'),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('accepts every name in the closed vocabulary', () => {
    const db = new Database(':memory:');
    db.exec(AGENT_DDL);

    for (const name of SOURCE_NAMES) {
      expect(() =>
        db.prepare(`INSERT INTO agent_sources (name) VALUES (?)`).run(name),
      ).not.toThrow();
    }
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
