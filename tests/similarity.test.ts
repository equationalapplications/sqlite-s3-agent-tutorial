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

function insertNotification(
  db: Database.Database,
  source: string,
  formattedMessage: string,
  postedAt: number,
  baseMessage: string | null = formattedMessage,
): number {
  const result = db
    .prepare(
      `INSERT INTO agent_notifications
         (source, value, formatted_message, posted_at, base_message)
       VALUES (?, 'v', ?, ?, ?)`,
    )
    .run(source, formattedMessage, postedAt, baseMessage);
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
  it('returns null when there is no embedded history yet', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();

    expect(findNearestMatch(db, unitVector(0))).toBeNull();
    cleanup(dir, db);
  });

  it('returns the closest notification (global, no per-source filter) and exposes baseMessage', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();

    const closeId = insertNotification(db, 'weather', 'close message', 1000, 'close base');
    insertEmbedding(db, closeId, unitVector(0));

    const farId = insertNotification(db, 'weather', 'far message', 2000, 'far base');
    insertEmbedding(db, farId, unitVector(1));

    const match = findNearestMatch(db, unitVector(0));
    expect(match).not.toBeNull();
    expect(match?.notificationId).toBe(closeId);
    expect(match?.baseMessage).toBe('close base');
    expect(match?.postedAt).toBe(1000);
    expect(match?.distance).toBeLessThan(0.01);
    cleanup(dir, db);
  });

  it('matches across sources (no per-source filter) — KNN is global', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather'), ('crypto')`).run();

    const cryptoId = insertNotification(db, 'crypto', 'crypto base', 1000, 'crypto base');
    insertEmbedding(db, cryptoId, unitVector(0));

    const weatherId = insertNotification(db, 'weather', 'weather base', 2000, 'weather base');
    insertEmbedding(db, weatherId, unitVector(5));

    const match = findNearestMatch(db, unitVector(0));
    expect(match?.notificationId).toBe(cryptoId); // crypto is closer than weather
    expect(match?.baseMessage).toBe('crypto base');
    cleanup(dir, db);
  });

  it('excludes rows whose base_message is NULL (legacy rows post-migration)', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather'), ('crypto')`).run();

    // Three legacy rows with base_message = NULL, vectors spanning the search space.
    // The closest vector candidate should be a CRYPTO row with NULL base_message —
    // a non-null row elsewhere must still be returned if present.
    const legacyCrypto = insertNotification(db, 'crypto', 'legacy crypto', 1000, null);
    insertEmbedding(db, legacyCrypto, unitVector(0)); // closest to the query below

    const legacyWeather = insertNotification(db, 'weather', 'legacy weather', 1100, null);
    insertEmbedding(db, legacyWeather, unitVector(1));

    const valid = insertNotification(db, 'weather', 'valid posted', 900, 'valid base');
    insertEmbedding(db, valid, unitVector(10)); // far from unitVector(0) but non-null base_message

    const match = findNearestMatch(db, unitVector(0));
    expect(match?.notificationId).toBe(valid);
    expect(match?.baseMessage).toBe('valid base');
    cleanup(dir, db);
  });

  it('returns null when every candidate has base_message = NULL', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather'), ('crypto')`).run();

    const legacy1 = insertNotification(db, 'weather', 'legacy', 1000, null);
    insertEmbedding(db, legacy1, unitVector(0));

    const legacy2 = insertNotification(db, 'crypto', 'legacy', 1100, null);
    insertEmbedding(db, legacy2, unitVector(1));

    expect(findNearestMatch(db, unitVector(0))).toBeNull();
    cleanup(dir, db);
  });

  it('returns null when the KNN window is filled with NULL rows even if a valid row exists further away', () => {
    // Pins the post-filter contract: the SQL `WHERE n.base_message IS NOT NULL` filter
    // runs after sqlite-vec's top-k scan, so a valid row that's outside the top-k window
    // must NOT be returned — only the null filter's outcome (null) is the answer.
    // KNN_CANDIDATES is 50 (see src/rag/similarity.ts); the test inserts 51 null rows
    // so the top-50 window is entirely null rows, with the valid row at rank 52.
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();

    for (let i = 0; i < 51; i += 1) {
      const id = insertNotification(db, 'weather', `legacy ${i}`, 1000 + i, null);
      insertEmbedding(db, id, unitVector(0)); // all 51 are tied at distance 0 from the query
    }

    const valid = insertNotification(db, 'weather', 'valid posted', 900, 'valid base');
    insertEmbedding(db, valid, unitVector(50)); // far from unitVector(0), outside top-50

    expect(findNearestMatch(db, unitVector(0))).toBeNull();
    cleanup(dir, db);
  });

  it('matches a recent (few-minutes-old) past notification — no age floor', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();

    // Reference tick: 5 minutes ago.
    const recent = insertNotification(db, 'weather', 'recent posted', 1000, 'recent base');
    insertEmbedding(db, recent, unitVector(0));

    // Query "now" (no time gap engineered in): the function takes no timestamp,
    // so any match from the corpus is valid — the no-age-floor decision is
    // pinned by the absence of a timestamp filter, not by an explicit one.
    const match = findNearestMatch(db, unitVector(0));
    expect(match?.notificationId).toBe(recent);
    expect(match?.baseMessage).toBe('recent base');
    cleanup(dir, db);
  });
});

describe('insertEmbedding', () => {
  it('stores a vector retrievable by a later findNearestMatch call', () => {
    const { dir, db } = setup();
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();
    const id = insertNotification(db, 'weather', 'stored message', 1000, 'stored base');

    expect(() => insertEmbedding(db, id, unitVector(3))).not.toThrow();

    const match = findNearestMatch(db, unitVector(3));
    expect(match?.notificationId).toBe(id);
    expect(match?.baseMessage).toBe('stored base');
    cleanup(dir, db);
  });
});
