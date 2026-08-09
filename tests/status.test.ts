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
      { source: 'weather', value: '72F', formattedMessage: 'Looks like 72F today!', postedAt: 1000 },
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
});