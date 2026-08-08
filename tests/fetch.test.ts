// tests/fetch.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';
import { createLocalStore } from '../src/store/local.js';
import { createLocalTemplateFormatter } from '../src/format/local.js';
import { runFetch } from '../src/agent/fetch.js';
import { fakeSourceFetcher, throwingSourceFetcher } from './helpers/fakeSourceFetcher.js';
import { fakeDiscordPoster } from './helpers/fakeDiscordPoster.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-fetch-test-'));
  const dbPath = join(dir, 'memory.db');
  const storeDir = join(dir, 'store');
  return {
    dbPath,
    store: createLocalStore(storeDir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('runFetch', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('bootstraps on first run: creates tables, inserts a notification, publishes to the store', async () => {
    let formatCalls = 0;
    const formatter = createLocalTemplateFormatter();
    const countingFormatter = {
      async format(source: 'weather' | 'crypto', value: string) {
        formatCalls++;
        return formatter.format(source, value);
      },
    };
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster,
      formatter: countingFormatter,
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(1);
    expect(poster.posted).toEqual(['Weather update: 72F']);
    expect(formatCalls).toBe(1);

    // Published to the store.
    const stored = await ctx.store.get('memory.db');
    expect(stored).not.toBeNull();
    ctx.cleanup();
  });

  it('dedup: unchanged value skips post, formatter call, and notification row', async () => {
    // Pre-seed agent_sources.last_value = '72F'.
    const db = openDatabase(ctx.dbPath);
    bootstrap(db);
    db.prepare(
      `INSERT INTO agent_sources (name, last_value) VALUES ('weather', '72F')`,
    ).run();
    db.close();
    await ctx.store.put('memory.db', readFileSync(ctx.dbPath), null);

    let formatCalls = 0;
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster,
      formatter: {
        async format(source, value) {
          formatCalls++;
          return `${source}: ${value}`;
        },
      },
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(0);
    expect(poster.posted).toEqual([]);
    expect(formatCalls).toBe(0);
    ctx.cleanup();
  });

  it('dedup on real change: inserts exactly one notification and updates last_value', async () => {
    const db = openDatabase(ctx.dbPath);
    bootstrap(db);
    db.prepare(
      `INSERT INTO agent_sources (name, last_value) VALUES ('weather', '72F')`,
    ).run();
    db.close();
    await ctx.store.put('memory.db', readFileSync(ctx.dbPath), null);

    const poster = fakeDiscordPoster();

    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['73F'])],
      poster,
      formatter: createLocalTemplateFormatter(),
      runId: 'r1',
      now: () => 1000,
    });

    const reopened = openDatabase(ctx.dbPath);
    const notifications = reopened
      .prepare(`SELECT * FROM agent_notifications`)
      .all() as Array<Record<string, unknown>>;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.formatted_message).toBeTruthy();

    const sourceRow = reopened
      .prepare(`SELECT last_value, last_posted_at FROM agent_sources WHERE name = 'weather'`)
      .get() as { last_value: string; last_posted_at: number };
    expect(sourceRow.last_value).toBe('73F');
    expect(sourceRow.last_posted_at).toBe(1000);
    reopened.close();
    ctx.cleanup();
  });

  it('partial-source failure does not poison the run: error recorded, other source posts, outcome success', async () => {
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [
        throwingSourceFetcher('weather', 'fetch timeout'),
        fakeSourceFetcher('crypto', ['67234.10']),
      ],
      poster,
      formatter: createLocalTemplateFormatter(),
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(1);
    expect(poster.posted).toEqual(['Crypto update: 67234.10']);

    const reopened = openDatabase(ctx.dbPath);
    const run = reopened.prepare(`SELECT error FROM agent_runs WHERE run_id = 'r1'`).get() as { error: string };
    expect(run.error).toMatch(/weather/);
    expect(run.error).toMatch(/fetch timeout/);
    reopened.close();
    ctx.cleanup();
  });

  it('LLM/formatter failure for one source does not poison the run', async () => {
    const poster = fakeDiscordPoster();
    const failingFormatter = {
      async format(source: 'weather' | 'crypto', value: string) {
        if (source === 'weather') throw new Error('formatter exploded');
        return `Crypto update: ${value}`;
      },
    };

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [
        fakeSourceFetcher('weather', ['72F']),
        fakeSourceFetcher('crypto', ['67234.10']),
      ],
      poster,
      formatter: failingFormatter,
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(poster.posted).toEqual(['Crypto update: 67234.10']);

    const reopened = openDatabase(ctx.dbPath);
    const notifications = reopened.prepare(`SELECT source FROM agent_notifications`).all() as Array<{ source: string }>;
    expect(notifications).toEqual([{ source: 'crypto' }]);
    reopened.close();
    ctx.cleanup();
  });

  it('conditional write 412 is honored: no upload, previous version untouched, run marked error', async () => {
    // First run publishes v1.
    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster: fakeDiscordPoster(),
      formatter: createLocalTemplateFormatter(),
      runId: 'r1',
      now: () => 1000,
    });
    const v1 = await ctx.store.get('memory.db');

    // Simulate a concurrent writer: corrupt the etag the second run will present by
    // publishing again out-of-band so the second run's captured hydrate etag goes stale.
    await ctx.store.put('memory.db', Buffer.concat([v1!.body, Buffer.from('x')]), v1!.etag);

    // Second run hydrates *before* the interleaving write above by using a store wrapper
    // that returns the stale etag captured at hydrate time — simulated directly by
    // constructing the fetch call with a store whose get() returns v1's stale etag.
    const staleStore = {
      ...ctx.store,
      async get() {
        return v1;
      },
    };

    await expect(
      runFetch({
        dbPath: ctx.dbPath,
        store: staleStore,
        storeKey: 'memory.db',
        sources: [fakeSourceFetcher('weather', ['73F'])],
        poster: fakeDiscordPoster(),
        formatter: createLocalTemplateFormatter(),
        runId: 'r2',
        now: () => 2000,
      }),
    ).rejects.toThrow(/PreconditionFailed/);

    const current = await ctx.store.get('memory.db');
    expect(current?.body.length).toBe(v1!.body.length + 1); // untouched by the failed r2 attempt

    const reopened = openDatabase(ctx.dbPath);
    const runRow = reopened.prepare(`SELECT outcome, error FROM agent_runs WHERE run_id = 'r2'`).get() as { outcome: string; error: string };
    expect(runRow.outcome).toBe('error');
    expect(runRow.error).toMatch(/PreconditionFailed/);
    reopened.close();
    ctx.cleanup();
  });
});
