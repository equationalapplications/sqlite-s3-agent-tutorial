// tests/fetch.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';
import { createLocalStore } from '../src/store/local.js';
import { createLocalTemplateFormatter } from '../src/format/local.js';
import { createLocalEmbedder } from '../src/embed/local.js';
import type { LoopContext } from '../src/format/types.js';
import type { MessageFormatter } from '../src/format/types.js';
import { runFetch } from '../src/agent/fetch.js';
import { buildFinalMessageForDiscord } from '../src/agent/fetch.js';
import { fakeSourceFetcher, throwingSourceFetcher } from './helpers/fakeSourceFetcher.js';
import { fakeDiscordPoster } from './helpers/fakeDiscordPoster.js';
import type { Embedder } from '../src/embed/titan.js';

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

/** A `MessageFormatter` that records every `format()` call and returns a fixed
 *  ~150-char `preMessage`. Useful for asserting exact call counts and for the
 *  snowball regression test (every tick produces the same base message, so every
 *  tick's RAG lookup matches the previous tick). */
function recordingFixedFormatter(preMessage = 'A short friendly comment. Today the weather is 72F and BTC is 67234.10. The vibe is calm, the city is bright, the work goes on.'): MessageFormatter & { calls: LoopContext[] } {
  const calls: LoopContext[] = [];
  return {
    calls,
    async format(ctx: LoopContext): Promise<string> {
      calls.push(ctx);
      return preMessage;
    },
  };
}

describe('runFetch', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('happy path with RAG history: one combined post, two notification rows, two embeddings, embed called once', async () => {
    // Both ticks use the same recordingFixedFormatter so each tick's preMessage
    // is identical and the second tick's RAG lookup is guaranteed to match the
    // first tick's embeddings (same vector → cosine distance ≈ 0). The character-
    // code-hash local embedder differentiates by string content, so two different
    // preMessages would produce different vectors and the second tick could miss
    // the first tick's embeddings.
    const formatter = recordingFixedFormatter();
    const realEmbedder = createLocalEmbedder();
    let embedCalls = 0;
    const wrappedEmbedder: Embedder = {
      async embed(text: string) {
        embedCalls++;
        return realEmbedder.embed(text);
      },
    };

    // First tick seeds the corpus.
    const first = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster: fakeDiscordPoster(),
      formatter,
      embedder: wrappedEmbedder,
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });
    expect(first.outcome).toBe('success');
    expect(first.notificationsSent).toBe(1);

    const embedCallsAfterFirst = embedCalls;

    // Second tick is the one we assert against.
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [
        fakeSourceFetcher('weather', ['73F']),
        fakeSourceFetcher('crypto', ['67500.00']),
      ],
      poster,
      formatter,
      embedder: wrappedEmbedder,
      weatherLocation: 'Brooklyn',
      runId: 'r2',
      now: () => 2000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(1);

    // Formatter called once per tick — two calls total, the second tick's call is what
    // we pin the LoopContext shape against.
    expect(formatter.calls).toHaveLength(2);
    const r2Ctx = formatter.calls[1];
    expect(r2Ctx?.date).toBe('1970-01-01'); // `now: () => 2000` is 2000ms after the epoch
    expect(r2Ctx?.location).toBe('Brooklyn');
    expect(r2Ctx?.readings.map((r) => ({ source: r.source, value: r.value }))).toEqual([
      { source: 'weather', value: '73F' },
      { source: 'crypto', value: '67500.00' },
    ]);

    // Discord posted exactly once on the second tick; the message is the recorder's
    // output with the suffix.
    expect(poster.posted).toHaveLength(1);
    expect(poster.posted[0]).toMatch(/^A short friendly comment\./);
    expect(poster.posted[0]).toContain('Reminds me of:');

    // The embed call runs once per tick (not per source) — one call on r1, one on r2.
    expect(embedCalls - embedCallsAfterFirst).toBe(1);

    // DB has two agent_notifications rows per tick (one per source) with the same
    // combined message and the same RAG match.
    const reopened = openDatabase(ctx.dbPath);
    const rows = reopened
      .prepare(
        `SELECT source, value, formatted_message, base_message, posted_at,
                nearest_match_id, nearest_match_distance
           FROM agent_notifications WHERE posted_at = 2000 ORDER BY source`,
      )
      .all() as Array<{
        source: string;
        value: string;
        formatted_message: string;
        base_message: string;
        posted_at: number;
        nearest_match_id: number | null;
        nearest_match_distance: number | null;
      }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.formatted_message).toBe(poster.posted[0]);
      expect(row.base_message).toBe(
        'A short friendly comment. Today the weather is 72F and BTC is 67234.10. The vibe is calm, the city is bright, the work goes on.',
      );
      expect(row.nearest_match_id).not.toBeNull();
      expect(row.posted_at).toBe(2000);
    }

    // Both notification rows share the same nearest_match_id (the global match).
    expect(rows[0]?.nearest_match_id).toBe(rows[1]?.nearest_match_id);

    // Two embeddings for each tick (one per source), keyed on base_message.
    const embCount = (reopened.prepare(`SELECT COUNT(*) AS c FROM agent_embeddings`).get() as { c: number }).c;
    expect(embCount).toBe(4); // 2 from r1 + 2 from r2
    reopened.close();
    ctx.cleanup();
  });

  it('first-tick path: no RAG history, posted message = preMessage (no suffix)', async () => {
    const formatter = recordingFixedFormatter();
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster,
      formatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(1);
    expect(poster.posted).toHaveLength(1);
    expect(poster.posted[0]).not.toContain('Reminds me of');

    const reopened = openDatabase(ctx.dbPath);
    const rows = reopened
      .prepare(`SELECT formatted_message, base_message, nearest_match_id FROM agent_notifications`)
      .all() as Array<{ formatted_message: string; base_message: string; nearest_match_id: number | null }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.formatted_message).toBe(row.base_message);
      expect(row.nearest_match_id).toBeNull();
    }
    reopened.close();
    ctx.cleanup();
  });

  it('brand-new source: agent_sources upsert runs before agent_notifications insert (no FK violation)', async () => {
    // Fresh DB: no `agent_sources` rows exist yet for 'weather' or 'crypto'. The first
    // tick on each is the brand-new path. The writer must upsert agent_sources before
    // inserting agent_notifications because of the FK on agent_notifications.source.
    const formatter = createLocalTemplateFormatter();
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster,
      formatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    const reopened = openDatabase(ctx.dbPath);
    const sources = reopened.prepare(`SELECT name FROM agent_sources ORDER BY name`).all() as Array<{ name: string }>;
    expect(sources.map((s) => s.name).sort()).toEqual(['crypto', 'weather']);
    const notifications = reopened.prepare(`SELECT source FROM agent_notifications`).all() as Array<{ source: string }>;
    expect(notifications.map((n) => n.source).sort()).toEqual(['crypto', 'weather']);
    reopened.close();
    ctx.cleanup();
  });

  it('legacy-corpus RAG: skips null base_message rows even when they are the closest vectors', async () => {
    // Seed with three notifications whose base_message is NULL (legacy post-migration).
    const db = openDatabase(ctx.dbPath);
    bootstrap(db);
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather'), ('crypto')`).run();

    const vector = new Array(256).fill(0);
    vector[0] = 1;

    const legacy1 = db
      .prepare(
        `INSERT INTO agent_notifications (source, value, formatted_message, posted_at, base_message)
         VALUES ('crypto', 'v', 'legacy crypto', 1000, NULL)`,
      )
      .run();
    const insertEmbedding = (await import('../src/rag/similarity.js')).insertEmbedding;
    insertEmbedding(db, Number(legacy1.lastInsertRowid), vector); // exact match for query

    db.prepare(
      `INSERT INTO agent_notifications (source, value, formatted_message, posted_at, base_message)
       VALUES ('weather', 'v', 'legacy weather', 1100, NULL)`,
    ).run();
    db.close();
    await ctx.store.put('memory.db', readFileSync(ctx.dbPath), null);

    const formatter = recordingFixedFormatter();
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['73F'])],
      poster,
      formatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 2000,
    });

    expect(result.outcome).toBe('success');
    // No valid match in the corpus → no suffix.
    expect(poster.posted[0]).not.toContain('Reminds me of');
    expect(poster.posted[0]).not.toContain('null');
    ctx.cleanup();
  });

  it('snowball regression: 20 consecutive ticks with the same fixed preMessage stay bounded', async () => {
    const formatter = recordingFixedFormatter();
    const poster = fakeDiscordPoster();
    const embedder = createLocalEmbedder();

    let now = 1000;
    for (let i = 0; i < 20; i++) {
      const tickStart = now;
      await runFetch({
        dbPath: ctx.dbPath,
        store: ctx.store,
        storeKey: 'memory.db',
        sources: [
          fakeSourceFetcher('weather', ['72F']),
          fakeSourceFetcher('crypto', ['67234.10']),
        ],
        poster,
        formatter,
        embedder,
        weatherLocation: 'NYC',
        runId: `r${i}`,
        now: () => tickStart,
      });
      now += 5 * 60 * 1000; // 5 minutes per tick
    }

    expect(poster.posted).toHaveLength(20);
    for (const message of poster.posted) {
      expect(message.length).toBeLessThan(500); // well under Discord's 2000-char limit
      // The suffix, if present, is built from a past base_message — never a past
      // formatted_message — so the chain never grows.
      expect(message).not.toMatch(/Reminds me of:.*Reminds me of:/);
    }
    ctx.cleanup();
  });

  it('matches a recent past tick (no age floor)', async () => {
    // Seed one tick.
    const first = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster: fakeDiscordPoster(),
      formatter: createLocalTemplateFormatter(),
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });
    expect(first.notificationsSent).toBe(1);

    // Second tick a few "minutes" later — the past tick is fresh, but still a valid match.
    const formatter = recordingFixedFormatter();
    const poster = fakeDiscordPoster();

    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['73F']), fakeSourceFetcher('crypto', ['67500.00'])],
      poster,
      formatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r2',
      now: () => 1000 + 5 * 60 * 1000, // 5 minutes later
    });

    expect(poster.posted[0]).toContain('Reminds me of:');
    ctx.cleanup();
  });

  it('runFetch never matches its own tick (lookup before insert)', async () => {
    // The RAG lookup runs before this tick's agent_embeddings row is inserted — so
    // the corpus at query time cannot contain the current tick's own message. Verified
    // by driving r1 with a fixed preMessage 'A' and r2 with a different fixed preMessage
    // 'B'. If the lookup ran after the insert, r2's suffix would reference 'B' (its own
    // base_message, distance 0). With the correct ordering, the suffix references 'A'.
    const formatter1 = recordingFixedFormatter('first tick message — A');
    const poster = fakeDiscordPoster();

    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster,
      formatter: formatter1,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    poster.posted.length = 0;
    const formatter2 = recordingFixedFormatter('second tick message — B');
    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['73F']), fakeSourceFetcher('crypto', ['67500.00'])],
      poster,
      formatter: formatter2,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r2',
      now: () => 2000,
    });

    expect(poster.posted).toHaveLength(1);
    // The suffix references the r1 base_message, not the r2 one.
    expect(poster.posted[0]).toContain('Reminds me of: first tick message — A');
    expect(poster.posted[0]).not.toContain('Reminds me of: second tick message — B');
    ctx.cleanup();
  });

  it('one source failing: the other contributes; formatter receives only the live reading', async () => {
    const formatter = recordingFixedFormatter();
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
      formatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(1);
    expect(formatter.calls[0]?.readings.map((r) => r.source)).toEqual(['crypto']);
    expect(poster.posted).toHaveLength(1);

    const reopened = openDatabase(ctx.dbPath);
    const run = reopened.prepare(`SELECT error FROM agent_runs WHERE run_id = 'r1'`).get() as { error: string };
    expect(run.error).toMatch(/weather/);
    const notifications = reopened.prepare(`SELECT source FROM agent_notifications`).all() as Array<{ source: string }>;
    expect(notifications).toEqual([{ source: 'crypto' }]);
    reopened.close();
    ctx.cleanup();
  });

  it('all sources failing: formatter not called, no post, no notifications, notificationsSent = 0', async () => {
    const formatter = recordingFixedFormatter();
    const poster = fakeDiscordPoster();

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [
        throwingSourceFetcher('weather', 'fetch timeout'),
        throwingSourceFetcher('crypto', 'rate limited'),
      ],
      poster,
      formatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(0);
    expect(formatter.calls).toHaveLength(0);
    expect(poster.posted).toHaveLength(0);

    const reopened = openDatabase(ctx.dbPath);
    const notifications = reopened.prepare(`SELECT * FROM agent_notifications`).all();
    expect(notifications).toHaveLength(0);
    reopened.close();
    ctx.cleanup();
  });

  it('formatter failure: caught, no RAG, no post, no notifications, snapshot published', async () => {
    const poster = fakeDiscordPoster();
    const failingFormatter: MessageFormatter = {
      async format(): Promise<string> {
        throw new Error('LLM exploded');
      },
    };

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster,
      formatter: failingFormatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(0);
    expect(poster.posted).toHaveLength(0);

    const reopened = openDatabase(ctx.dbPath);
    const run = reopened.prepare(`SELECT error FROM agent_runs WHERE run_id = 'r1'`).get() as { error: string };
    expect(run.error).toMatch(/LLM exploded/);
    const notifications = reopened.prepare(`SELECT * FROM agent_notifications`).all();
    expect(notifications).toHaveLength(0);
    reopened.close();
    ctx.cleanup();
  });

  it('Titan embed failure: caught, post still happens with no suffix, embedder called once total, no agent_embeddings this tick', async () => {
    const formatter = recordingFixedFormatter();
    const poster = fakeDiscordPoster();
    let embedCalls = 0;
    const failingEmbedder: Embedder = {
      async embed(): Promise<number[]> {
        embedCalls++;
        throw new Error('Titan throttled');
      },
    };

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster,
      formatter,
      embedder: failingEmbedder,
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(1);
    expect(poster.posted).toHaveLength(1);
    expect(poster.posted[0]).not.toContain('Reminds me of');

    // The embedder was called exactly once (the failed call), not a second time as a
    // fallback. This pins the spec's "no second Titan call" rule for the RAG failure path.
    expect(embedCalls).toBe(1);

    const reopened = openDatabase(ctx.dbPath);
    const rows = reopened
      .prepare(`SELECT nearest_match_id, base_message FROM agent_notifications`)
      .all() as Array<{ nearest_match_id: number | null; base_message: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.nearest_match_id).toBeNull();
      // The fixed formatter always returns the same string — no need to re-invoke it.
      expect(row.base_message).toBe(
        'A short friendly comment. Today the weather is 72F and BTC is 67234.10. The vibe is calm, the city is bright, the work goes on.',
      );
    }
    const embCount = (reopened.prepare(`SELECT COUNT(*) AS c FROM agent_embeddings`).get() as { c: number }).c;
    expect(embCount).toBe(0); // no pre-vector → no insert
    reopened.close();
    ctx.cleanup();
  });

  it('post failure: caught, no per-source rows, no embeddings, snapshot published', async () => {
    const formatter = recordingFixedFormatter();
    const throwingPoster = {
      async post(): Promise<void> {
        throw new Error('Discord 500');
      },
    };

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F']), fakeSourceFetcher('crypto', ['67234.10'])],
      poster: throwingPoster,
      formatter,
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(result.notificationsSent).toBe(0);

    const reopened = openDatabase(ctx.dbPath);
    const run = reopened.prepare(`SELECT error FROM agent_runs WHERE run_id = 'r1'`).get() as { error: string };
    expect(run.error).toMatch(/Discord 500/);
    const notifications = reopened.prepare(`SELECT * FROM agent_notifications`).all();
    expect(notifications).toHaveLength(0);
    const embCount = (reopened.prepare(`SELECT COUNT(*) AS c FROM agent_embeddings`).get() as { c: number }).c;
    expect(embCount).toBe(0);
    reopened.close();
    ctx.cleanup();
  });

  it('conditional write 412: no upload, previous version untouched, run marked error', async () => {
    // First run publishes v1.
    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster: fakeDiscordPoster(),
      formatter: createLocalTemplateFormatter(),
      embedder: createLocalEmbedder(),
      weatherLocation: 'NYC',
      runId: 'r1',
      now: () => 1000,
    });
    const v1 = await ctx.store.get('memory.db');

    // Simulate a concurrent writer: append a byte so the next run's captured etag is stale.
    await ctx.store.put('memory.db', Buffer.concat([v1!.body, Buffer.from('x')]), v1!.etag);

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
        embedder: createLocalEmbedder(),
        weatherLocation: 'NYC',
        runId: 'r2',
        now: () => 2000,
      }),
    ).rejects.toThrow(/PreconditionFailed/);

    const current = await ctx.store.get('memory.db');
    expect(current?.body.length).toBe(v1!.body.length + 1);

    const reopened = openDatabase(ctx.dbPath);
    const runRow = reopened.prepare(`SELECT outcome, error FROM agent_runs WHERE run_id = 'r2'`).get() as { outcome: string; error: string };
    expect(runRow.outcome).toBe('error');
    expect(runRow.error).toMatch(/PreconditionFailed/);
    reopened.close();
    ctx.cleanup();
  });
});

describe('buildFinalMessageForDiscord', () => {
  it('returns preMessage unchanged when there is no RAG match', () => {
    const result = buildFinalMessageForDiscord('hello world', null);
    expect(result).toBe('hello world');
  });

  it('appends the suffix verbatim when preMessage + suffix fits under 2000 chars', () => {
    const preMessage = 'A short comment about today.';
    const baseMessage = 'A past comment from yesterday.';
    const result = buildFinalMessageForDiscord(preMessage, baseMessage);
    expect(result).toBe(`${preMessage}\n\nReminds me of: ${baseMessage}`);
    expect(result.length).toBeLessThanOrEqual(2000);
  });

  it('truncates the suffix with a clip marker when it would exceed 2000 chars', () => {
    // preMessage consumes 1900 chars; suffix separator is 19 chars; baseMessage fills
    // 200 chars, so the whole suffix is 219 chars and total would be 2119.
    const preMessage = 'a'.repeat(1900);
    const baseMessage = 'b'.repeat(200);
    const result = buildFinalMessageForDiscord(preMessage, baseMessage);
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result.startsWith(preMessage)).toBe(true);
    expect(result).toContain('Reminds me of: ');
    expect(result.endsWith('...')).toBe(true);
    // The baseMessage portion is clipped — not the whole 200 chars survive.
    expect(result.length).toBeLessThan(preMessage.length + 19 + 200);
  });

  it('truncates preMessage itself when it alone exceeds 2000 chars, with no suffix', () => {
    const preMessage = 'a'.repeat(3000);
    const result = buildFinalMessageForDiscord(preMessage, 'a past message');
    expect(result.length).toBe(2000);
    expect(result).not.toContain('Reminds me of');
  });

  it('omits the suffix entirely when there is no room for even a clipped version', () => {
    // preMessage leaves only 5 chars of headroom — separator (19) + clip marker (3) = 22,
    // so the helper drops the suffix instead of producing a meaningless stub.
    const preMessage = 'a'.repeat(1995);
    const baseMessage = 'b'.repeat(200);
    const result = buildFinalMessageForDiscord(preMessage, baseMessage);
    expect(result).toBe(preMessage);
  });

  it('accepts a custom limit (used for the snowball regression test threshold of 500)', () => {
    const preMessage = 'a'.repeat(400);
    const baseMessage = 'b'.repeat(200);
    const result = buildFinalMessageForDiscord(preMessage, baseMessage, 500);
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.startsWith(preMessage)).toBe(true);
    expect(result.endsWith('...')).toBe(true);
  });
});
