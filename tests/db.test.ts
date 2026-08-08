// tests/db.test.ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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
