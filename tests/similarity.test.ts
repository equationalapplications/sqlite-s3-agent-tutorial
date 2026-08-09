import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';
import { findNearestMatch, insertEmbedding } from '../src/rag/similarity.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-similarity-test-'));
  const db = openDatabase(join(dir, 'memory.db'));
  bootstrap(db);
  return { dir, db };
}

function cleanup(dir: string, db: Database.Database) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

function insertNotification(db: Database.Database, source: string, formattedMessage: string, postedAt: number): number {
  const result = db
    .prepare(
      `INSERT INTO agent_notifications (source, value, formatted_message, posted_at)
       VALUES (?, 'v', ?, ?)`,
    )
    .run(source, formattedMessage, postedAt);
  return Number(result.lastInsertRowid);
}

/** 256-dim vector with a 1 at `index` and 0 elsewhere — lets tests reason about cosine
 *  distance by construction instead of by coincidence. */
function unitVector(index: number): number[] {
  const vector = new Array(256).fill(0);
  vector[index] = 1;
  return vector;
}

describe('findNearestMatch', () => {
  it('returns null when the source has no embedded history yet', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();

    const result = findNearestMatch(db, 'weather', unitVector(0));
    expect(result).toBeNull();
    cleanup(dir, db);
  });

  it('returns the closest same-source notification by cosine distance', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();

    const closeId = insertNotification(db, 'weather', 'close message', 1000);
    insertEmbedding(db, closeId, unitVector(0));

    const farId = insertNotification(db, 'weather', 'far message', 2000);
    insertEmbedding(db, farId, unitVector(1));

    const match = findNearestMatch(db, 'weather', unitVector(0));
    expect(match).not.toBeNull();
    expect(match?.notificationId).toBe(closeId);
    expect(match?.formattedMessage).toBe('close message');
    expect(match?.postedAt).toBe(1000);
    expect(match?.distance).toBeLessThan(0.01); // near-identical vector, near-zero distance
    cleanup(dir, db);
  });

  it('filters to the requested source even when another source has a closer vector', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather'), ('crypto')`).run();

    const cryptoId = insertNotification(db, 'crypto', 'crypto message', 1000);
    insertEmbedding(db, cryptoId, unitVector(0)); // exact match for the query vector below

    const weatherId = insertNotification(db, 'weather', 'weather message', 2000);
    insertEmbedding(db, weatherId, unitVector(5)); // far from the query vector

    const match = findNearestMatch(db, 'weather', unitVector(0));
    expect(match?.notificationId).toBe(weatherId); // not cryptoId, despite being the closer vector
    cleanup(dir, db);
  });
});

describe('insertEmbedding', () => {
  it('stores a vector retrievable by a later findNearestMatch call', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();
    const id = insertNotification(db, 'weather', 'stored message', 1000);

    expect(() => insertEmbedding(db, id, unitVector(3))).not.toThrow();

    const match = findNearestMatch(db, 'weather', unitVector(3));
    expect(match?.notificationId).toBe(id);
    cleanup(dir, db);
  });
});
