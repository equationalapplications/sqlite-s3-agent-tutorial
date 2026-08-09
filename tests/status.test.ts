// tests/status.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';
import { createLocalStore } from '../src/store/local.js';
import { createStatusReader } from '../src/agent/status.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-status-test-'));
  const dbPath = join(dir, 'memory.db');
  const store = createLocalStore(join(dir, 'store'));
  return { dir, dbPath, store };
}

async function seedSnapshot(dbPath: string, store: ReturnType<typeof createLocalStore>) {
  const db = openDatabase(dbPath);
  bootstrap(db);
  db.prepare(
    `INSERT INTO agent_sources (name, last_value, last_fetched_at, last_posted_at)
     VALUES ('weather', '72F', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_notifications (source, value, formatted_message, posted_at)
     VALUES ('weather', '72F', 'Looks like 72F today!', 1000)`,
  ).run();
  db.close();
  return store.put('memory.db', readFileSync(dbPath), null);
}

describe('createStatusReader', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  // afterEach rather than per-test cleanup calls: a failing assertion earlier in the
  // body would otherwise leak the temp dir, which can bleed into the next test and
  // makes failures harder to reproduce. `force: true` keeps this a no-op if the dir was
  // already cleaned up by some other path.
  afterEach(() => {
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('returns the empty-state JSON when no snapshot exists yet, without opening a handle', async () => {
    const reader = createStatusReader(ctx.dbPath);
    const result = await reader.getStatus(ctx.store, 'memory.db');

    expect(result).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });
  });

  it('downloads and returns sources + recentNotifications on first call', async () => {
    await seedSnapshot(ctx.dbPath, ctx.store);

    // The reader's dbPath (reader-copy.db) does not exist yet, so the cold-start branch
    // is the one under test without needing to pre-create or corrupt a file at the path.
    const reader = createStatusReader(join(ctx.dir, 'reader-copy.db'));
    const result = await reader.getStatus(ctx.store, 'memory.db');

    expect(result.snapshotVersion).not.toBeNull();
    expect(result.sources).toEqual([
      { name: 'weather', lastValue: '72F', lastFetchedAt: 1000, lastPostedAt: 1000 },
    ]);
    expect(result.recentNotifications).toEqual([
      { source: 'weather', value: '72F', formattedMessage: 'Looks like 72F today!', postedAt: 1000, nearestMatch: null },
    ]);
  });

  it('reuses the cached handle on a second call when the version is unchanged (no re-download)', async () => {
    await seedSnapshot(ctx.dbPath, ctx.store);
    const readerDbPath = join(ctx.dir, 'reader-copy.db');
    const reader = createStatusReader(readerDbPath);

    await reader.getStatus(ctx.store, 'memory.db');

    let getCalls = 0;
    const countingStore = {
      ...ctx.store,
      async get(key: string) {
        getCalls++;
        return ctx.store.get(key);
      },
    };

    const second = await reader.getStatus(countingStore, 'memory.db');
    expect(getCalls).toBe(0); // head-only, no re-download
    expect(second.sources).toHaveLength(1);
  });

  it('re-downloads and re-opens when the version changes', async () => {
    await seedSnapshot(ctx.dbPath, ctx.store);
    const readerDbPath = join(ctx.dir, 'reader-copy.db');
    const reader = createStatusReader(readerDbPath);

    const first = await reader.getStatus(ctx.store, 'memory.db');

    // A new fetch run changes the snapshot.
    const db = openDatabase(ctx.dbPath);
    db.prepare(
      `UPDATE agent_sources SET last_value = '73F', last_fetched_at = 2000, last_posted_at = 2000
       WHERE name = 'weather'`,
    ).run();
    db.close();
    const priorEtag = (await ctx.store.head('memory.db'))?.etag ?? null;
    await ctx.store.put('memory.db', readFileSync(ctx.dbPath), priorEtag);

    const second = await reader.getStatus(ctx.store, 'memory.db');
    expect(second.snapshotVersion).not.toBe(first.snapshotVersion);
    expect(second.sources).toEqual([
      { name: 'weather', lastValue: '73F', lastFetchedAt: 2000, lastPostedAt: 2000 },
    ]);
  });

  it('clears cache state when store.get throws in the cache-miss path and recovers', async () => {
    // The cache-miss branch in `src/agent/status.ts` must preserve the spec §4.3.1
    // invariant: after any throwing step inside the branch, the cache is left at
    // `(cachedEtag: null, db: undefined)`, NOT `(cachedEtag: <old>, db: undefined)`.
    // The pre-fix implementation cleared `db` at the top of the branch but left
    // `cachedEtag` at the prior warm-cache value, which violates the invariant as
    // soon as `store.get` (or `writeFileSync`, or `openReadOnlyDatabase`) throws.
    let validBytes: Buffer = Buffer.alloc(0);
    let nextEtag = 'warm-etag';
    let getThrows = false;
    const adaptiveStore = {
      ...ctx.store,
      async get(key: string) {
        if (getThrows) throw new Error('s3 transient');
        return { body: validBytes, etag: nextEtag };
      },
      async head(key: string) {
        return { etag: nextEtag };
      },
    };

    // Seed a valid snapshot so we have bytes to recover with.
    await seedSnapshot(ctx.dbPath, ctx.store);
    validBytes = readFileSync(ctx.dbPath);

    const readerDbPath = join(ctx.dir, 'reader-copy.db');
    const reader = createStatusReader(readerDbPath);

    // Warm the cache so the failing call is a warm-cache-miss, not a cold start.
    // Without warming, cachedEtag is already null on the failing call and the
    // invariant assertion below would pass trivially on the buggy implementation.
    await reader.getStatus(adaptiveStore, 'memory.db');
    expect(reader.__peekReaderState()).toEqual({ cachedEtag: 'warm-etag', dbIsOpen: true });

    // Force a cache-miss (different ETag) and have store.get throw. The fix clears
    // both fields at the top of the branch, so a throw anywhere inside leaves the
    // cache in the empty state. The pre-fix left cachedEtag at 'warm-etag'.
    nextEtag = 'raced-etag';
    getThrows = true;

    await expect(reader.getStatus(adaptiveStore, 'memory.db')).rejects.toThrow('s3 transient');
    // The invariant: cache cleared even though openReadOnlyDatabase was never reached.
    // The pre-fix implementation left `(cachedEtag: 'warm-etag', db: undefined)` here.
    expect(reader.__peekReaderState()).toEqual({ cachedEtag: null, dbIsOpen: false });

    // Network recovers — the next call retries the cache-miss path from a clean state.
    getThrows = false;

    const recovered = await reader.getStatus(adaptiveStore, 'memory.db');
    expect(recovered.snapshotVersion).toBe('raced-etag');
    expect(recovered.sources).toEqual([
      { name: 'weather', lastValue: '72F', lastFetchedAt: 1000, lastPostedAt: 1000 },
    ]);
    expect(reader.__peekReaderState()).toEqual({ cachedEtag: 'raced-etag', dbIsOpen: true });
  });

  it('clears cache state on HEAD-succeeds-GET-null and recovers on the next call', async () => {
    // The HEAD-succeeds-GET-fails branch (object deleted between HEAD and GET) must:
    // (a) return the empty-state JSON (treating it as no-snapshot, not throwing),
    // (b) clear the cache to `(cachedEtag: null, db: undefined)` so the next call sees
    //     a clean cache-miss — NOT leave `(cachedEtag: <old>, db: undefined)` if the
    //     reader had a warm cache before the race (spec §4.3.1),
    // (c) once the underlying object exists, return the seeded data without being
    //     stuck in a HEAD→GET→empty cycle.
    let objectExists = true;
    let validBytes: Buffer = Buffer.alloc(0);
    let nextEtag = 'warm-etag';
    const adaptiveStore = {
      ...ctx.store,
      async get(key: string) {
        if (!objectExists) return null; // HEAD-succeeds-GET-fails
        return { body: validBytes, etag: nextEtag };
      },
      async head(key: string) {
        return { etag: nextEtag };
      },
    };

    await seedSnapshot(ctx.dbPath, ctx.store);
    validBytes = readFileSync(ctx.dbPath);

    const readerDbPath = join(ctx.dir, 'reader-copy.db');
    const reader = createStatusReader(readerDbPath);

    // Warm the cache so the failing call is a warm-cache-miss. Without this,
    // cachedEtag is already null on the failing call and the invariant assertion
    // below passes trivially on the buggy implementation.
    await reader.getStatus(adaptiveStore, 'memory.db');
    expect(reader.__peekReaderState()).toEqual({ cachedEtag: 'warm-etag', dbIsOpen: true });

    // HEAD succeeds for a different ETag (object was replaced between warm-up and
    // now) but GET returns null (race condition — object deleted between calls).
    objectExists = false;
    nextEtag = 'raced-etag';

    const first = await reader.getStatus(adaptiveStore, 'memory.db');
    expect(first).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });

    // The invariant: after GET-null, the cache must be back to `(null, undefined)`.
    // The pre-fix implementation left it at `(cachedEtag: 'raced-etag', db: undefined)`
    // — an invalid state per spec §4.3.1 — and this assertion catches it.
    expect(reader.__peekReaderState()).toEqual({ cachedEtag: null, dbIsOpen: false });

    // Object materializes (operator creates it out-of-band, or writer runs).
    objectExists = true;
    nextEtag = 'fixed-etag';

    const recovered = await reader.getStatus(adaptiveStore, 'memory.db');
    expect(recovered.snapshotVersion).toBe('fixed-etag');
    expect(recovered.sources).toEqual([
      { name: 'weather', lastValue: '72F', lastFetchedAt: 1000, lastPostedAt: 1000 },
    ]);
  });

  it('includes nearestMatch when a notification has a recorded nearest_match_id', async () => {
    const db = openDatabase(ctx.dbPath);
    bootstrap(db);
    db.prepare(
      `INSERT INTO agent_sources (name, last_value, last_fetched_at, last_posted_at)
       VALUES ('weather', '72F', 1000, 1000)`,
    ).run();
    const firstId = db
      .prepare(
        `INSERT INTO agent_notifications (source, value, formatted_message, posted_at)
         VALUES ('weather', '72F', 'Looks like 72F today!', 1000)`,
      )
      .run().lastInsertRowid as number;
    db.prepare(
      `INSERT INTO agent_notifications
         (source, value, formatted_message, posted_at, nearest_match_id, nearest_match_distance)
       VALUES ('weather', '75F', 'A bit warmer today!', 2000, ?, 0.05)`,
    ).run(firstId);
    db.close();
    await ctx.store.put('memory.db', readFileSync(ctx.dbPath), null);

    const reader = createStatusReader(join(ctx.dir, 'reader-copy.db'));
    const result = await reader.getStatus(ctx.store, 'memory.db');

    const secondNotification = result.recentNotifications.find((n) => n.value === '75F');
    expect(secondNotification?.nearestMatch).toEqual({
      source: 'weather',
      formattedMessage: 'Looks like 72F today!',
      postedAt: 1000,
      distance: 0.05,
    });

    const firstNotification = result.recentNotifications.find((n) => n.value === '72F');
    expect(firstNotification?.nearestMatch).toBeNull();
  });
});