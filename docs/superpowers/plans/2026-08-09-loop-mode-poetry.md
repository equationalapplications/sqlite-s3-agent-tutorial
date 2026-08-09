# Loop Mode + Poetic Closing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the once-daily EventBridge schedule with a 5-minute loop, write one combined message per tick (date + location + readings + haiku + mechanical "Reminds me of" suffix from a global RAG match), and add `loop-start.sh` / `loop-stop.sh` scripts that toggle the EventBridge rule directly via `aws events`.

**Architecture:** The writer (`runFetch`) is restructured from a per-source format+post loop into a single combined-message flow: fetch all sources, format once with a clean `LoopContext` (no RAG fields), embed the LLM's pre-suffix output once, run a global KNN lookup against post-migration notifications, mechanically append `\n\nReminds me of: <past.baseMessage>` if a match exists, post once, write per-source `agent_notifications` rows with the same combined message, and reuse the pre-vector to insert embeddings (one Titan call per tick, not per source). The `base_message` column on `agent_notifications` stores the LLM's pre-suffix text and is the corpus/query key — `formatted_message` keeps the full posted text. Script-level control (`aws events enable-rule` / `disable-rule`) reads the rule name from a new `LoopRuleName` stack output.

**Tech Stack:** TypeScript / Node 24 / ESM, vitest, `aws-sdk-client-mock`, AWS CDK, AWS CLI (EventBridge).

**Design doc:** [docs/superpowers/specs/2026-08-09-loop-mode-poetry-design.md](../specs/2026-08-09-loop-mode-poetry-design.md)

---

## File Structure

**Modified:**
- `src/agent/fetch.ts` — restructured to combined-message flow; no dedup; new `weatherLocation` param; `base_message` writes.
- `src/format/types.ts` — adds `LoopContext` / `LoopReading`; deletes `SimilarPastResult`; `MessageFormatter.format(source, value, similarPast)` → `format(ctx: LoopContext)`.
- `src/format/bedrock.ts` — new haiku-focused system prompt; new `format(ctx)` signature; no RAG fields in the prompt.
- `src/format/local.ts` — new `format(ctx)` signature; deletes the `LABELS` map; emits a `"{date} — {source}: {value}, ..."` shape.
- `src/rag/similarity.ts` — `findNearestMatch` loses its `source` param; adds `WHERE n.base_message IS NOT NULL`; returns `baseMessage` instead of `formattedMessage`; `KNN_CANDIDATES` doc comment updated to the new cadence math.
- `src/db/bootstrap.ts` — adds the `base_message` column migration (PRAGMA-guarded, mirroring the existing nearest-match columns).
- `src/localFetch.ts` — passes `weatherLocation` through to `runFetch`.
- `src/handler.ts` — passes `weatherLocation` through to `runFetch`.
- `infra/stack.ts` — schedule `5 minutes` (was `1 day`); new `LoopRuleName` `CfnOutput`; Lambda timeout `60s` (was `30s`).
- `tests/fetch.test.ts` — rewritten for combined-message flow; new test cases from spec §7.
- `tests/similarity.test.ts` — rewritten for global KNN + `baseMessage` return shape; new tests for null `base_message` exclusion and the no-age-floor decision.
- `tests/format.test.ts` — updated for new `format(ctx)` signature.
- `tests/bedrock.test.ts` — updated for new `format(ctx)` signature, new system prompt, and the removal of the "closest past reading" prompt field.
- `tests/handler.test.ts` — updated to assert exactly one Converse call per tick.
- `package.json` — adds `loop-start` and `loop-stop` npm scripts.
- `README.md` — adds a "Loop mode" subsection documenting the scripts and the redeploy-re-enables-the-loop gotcha.
- `docs/07-budget-protection.md` — adds a paragraph about the 5-min loop's Bedrock-call rate and `agent_notifications` / `agent_embeddings` growth.

**Created:**
- `scripts/loop-start.sh` — calls `aws events enable-rule` after reading `LoopRuleName` from stack outputs.
- `scripts/loop-stop.sh` — calls `aws events disable-rule` after reading `LoopRuleName` from stack outputs.

---

## Task 1: Add `base_message` column migration to bootstrap

**Files:**
- Modify: `src/db/bootstrap.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write a failing test for the new column**

Append the following test to `tests/db.test.ts` (read the file first to find the right `describe` block — the existing tests in that file cover the `addNearestMatchColumnsIfMissing` paths; add the new test inside the same `describe` so it shares the `setup()` helper):

```typescript
  it('adds base_message to agent_notifications when missing, and is idempotent on re-run', () => {
    const { db } = setup();

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
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db.test.ts`
Expected: FAIL — `base_message` column not found in `agent_notifications` (the `cols.find(...)` returns `undefined`).

- [ ] **Step 3: Implement the migration**

Replace `src/db/bootstrap.ts` with the following:

```typescript
import type Database from 'better-sqlite3';
import { AGENT_DDL } from './schema.js';

/** Creates the three agent tables plus `agent_embeddings`. Idempotent — safe to call on
 *  every writer invocation. */
export function bootstrap(db: Database.Database): void {
  db.exec(AGENT_DDL);
  addMissingColumns(db);
}

/**
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so idempotency is
 * implemented by checking `PRAGMA table_info` first. These columns record the
 * past-notification relationship at the time this notification was posted:
 *
 * - `nearest_match_id` / `nearest_match_distance` — RAG design spec §3.2
 * - `base_message` — loop-mode + poetic-closing design spec §3. Stores the LLM's
 *   pre-suffix output (the friendly comment + haiku). The RAG corpus embeds this
 *   column, and `findNearestMatch` returns it for the "Reminds me of" suffix —
 *   never the posted `formatted_message` — so the suffix cannot snowball.
 *   Nullable so legacy rows post-migration carry `NULL` and the LIKE exclusion
 *   in `findNearestMatch` keeps them out of match candidacy.
 */
function addMissingColumns(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(agent_notifications)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has('nearest_match_id')) {
    db.exec(
      `ALTER TABLE agent_notifications ADD COLUMN nearest_match_id INTEGER REFERENCES agent_notifications(id)`,
    );
  }
  if (!names.has('nearest_match_distance')) {
    db.exec(`ALTER TABLE agent_notifications ADD COLUMN nearest_match_distance REAL`);
  }
  if (!names.has('base_message')) {
    db.exec(`ALTER TABLE agent_notifications ADD COLUMN base_message TEXT`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/db.test.ts`
Expected: PASS — all cases, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/db/bootstrap.ts tests/db.test.ts
git commit -m "feat(schema): add base_message column for snowball-free RAG suffix"
```

---

## Task 2: Update `findNearestMatch` to global KNN returning `baseMessage`

**Files:**
- Modify: `src/rag/similarity.ts`
- Test: `tests/similarity.test.ts`

- [ ] **Step 1: Write a failing test for the new return shape and null-base_message filter**

Replace `tests/similarity.test.ts` (currently 98 lines) with the following — keeping the same `setup()` / `insertNotification()` / `unitVector()` helpers but rewriting the `findNearestMatch` describe block for the new signature:

```typescript
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
    db.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run();

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/similarity.test.ts`
Expected: FAIL — `findNearestMatch` still takes a `source` parameter and returns `formattedMessage`; the new tests reference the new signature and the new field name.

- [ ] **Step 3: Update `src/rag/similarity.ts`**

Replace `src/rag/similarity.ts` (currently 73 lines) with the following:

```typescript
import type Database from 'better-sqlite3';

/** A match found by `findNearestMatch` — the past tick's pre-suffix output (the LLM's
 *  clean message, never its `formatted_message`). The writer uses `baseMessage` to
 *  build the "Reminds me of" suffix; using `formattedMessage` instead would let the
 *  suffix grow recursively and eventually blow the Discord 2000-char limit (loop-mode
 *  + poetic-closing spec §1, §4.5). */
export interface NearestMatch {
  notificationId: number;
  distance: number;
  baseMessage: string;
  postedAt: number;
}

/**
 * Fixed KNN scan size (loop-mode + poetic-closing spec §4.5). At 5-min cadence, 2 sources,
 * 1 row per source per tick, 50 candidates is roughly 2 hours of wall-clock history —
 * a generous window for the loop's intended short-lived test runs (5–10 minutes), so the
 * ceiling is unlikely to bind in practice. Past this ceiling, `findNearestMatch` can miss
 * the true nearest neighbor if it isn't among the 50 closest across `agent_embeddings`.
 * Same pattern as `RECENT_NOTIFICATIONS_LIMIT` in `src/agent/status.ts`.
 */
const KNN_CANDIDATES = 50;

interface CandidateRow {
  notificationId: number;
  baseMessage: string;
  postedAt: number;
  distance: number;
}

/**
 * Finds the closest past notification to `queryVector` across all sources (global KNN,
 * no per-source filter), or `null` if no eligible history exists. The `agent_embeddings`
 * table is shared across sources (RAG design spec §3.1).
 *
 * `WHERE n.base_message IS NOT NULL` is applied as a post-filter on the top-`k`
 * candidates — `sqlite-vec`'s `k` parameter operates on the raw vector scan, so this
 * filter runs after the KNN. It is required: without it, legacy rows (post-migration
 * `base_message = NULL`) would surface as `agent_embeddings` candidates whose joined
 * `base_message` is null, and the writer would post the literal string `"null"` into
 * the "Reminds me of" suffix.
 *
 * Step-ordering note: this scan runs *before* the current tick's `insertEmbedding` (which
 * happens after the Discord post in `runFetch`), so the corpus at query time contains
 * only notifications already posted by prior ticks. The current tick's own message
 * cannot be its own match — no explicit age floor is needed to enforce that.
 */
export function findNearestMatch(db: Database.Database, queryVector: number[]): NearestMatch | null {
  const rows = db
    .prepare(
      `SELECT n.id AS notificationId, n.base_message AS baseMessage,
              n.posted_at AS postedAt, e.distance AS distance FROM agent_embeddings e
       JOIN agent_notifications n ON n.id = e.notification_id
       WHERE e.embedding MATCH ? AND k = ?
         AND n.base_message IS NOT NULL
       ORDER BY e.distance`,
    )
    .all(JSON.stringify(queryVector), KNN_CANDIDATES) as CandidateRow[];

  const match = rows[0];
  if (match === undefined) return null;

  return {
    notificationId: match.notificationId,
    distance: match.distance,
    baseMessage: match.baseMessage,
    postedAt: match.postedAt,
  };
}

/** Stores `vector` for `notificationId`, making it a future `findNearestMatch`
 *  candidate. Called once per posted notification (RAG design spec §3.1).
 *
 *  `notificationId` must be bound as a `BigInt`: binding it as a plain JS number trips
 *  `vec0`'s "Only integers are allowed for primary key values" check in `better-sqlite3`
 *  (verified against installed sqlite-vec v0.1.9 + better-sqlite3 v13 — the same literal
 *  value works fine via `db.exec` with an inlined integer, so this is specific to bound
 *  parameters on this virtual table, not a general integer-vs-float issue). */
export function insertEmbedding(db: Database.Database, notificationId: number, vector: number[]): void {
  db.prepare(`INSERT INTO agent_embeddings (notification_id, embedding) VALUES (?, vec_f32(?))`).run(
    BigInt(notificationId),
    JSON.stringify(vector),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/similarity.test.ts`
Expected: PASS — all cases.

- [ ] **Step 5: Run typecheck to catch any leftover callers**

Run: `npm run typecheck`
Expected: FAIL — `findNearestMatch` callers in `src/agent/fetch.ts` still pass a `source` argument and access `formattedMessage`. This is expected; Task 5 fixes `fetch.ts`. Note the failures; we'll continue.

- [ ] **Step 6: Commit**

```bash
git add src/rag/similarity.ts tests/similarity.test.ts
git commit -m "feat(rag): global KNN returns baseMessage, filter null base_message"
```

---

## Task 3: Add `LoopContext` types and the new `format()` signature

**Files:**
- Modify: `src/format/types.ts`

- [ ] **Step 1: Replace `src/format/types.ts`**

Replace `src/format/types.ts` (currently 22 lines) with the following:

```typescript
import type { SourceName } from '../db/schema.js';

export type { SourceName };

/** One entry per source that fetched successfully this tick — source-agnostic, so a
 *  third source added per `docs/04-extending.md` shows up in the prompt automatically
 *  (loop-mode + poetic-closing spec §4.2). A failed source is absent from the array
 *  rather than represented as `'<unavailable>'` — the LLM sees only sources it has
 *  real data for. */
export interface LoopReading {
  source: SourceName;
  value: string;
}

/** The full set of inputs the formatter sees per tick. `date` and `location` are simple
 *  ambient context; `readings` carries the structured data the LLM should weave into
 *  its friendly comment and closing haiku. RAG is intentionally *not* in this shape:
 *  the LLM is not told about the closest past reading. The "Reminds me of" suffix is
 *  appended mechanically in the writer after the format call returns. */
export interface LoopContext {
  date: string;            // ISO date, e.g. "2026-08-09"
  location: string;        // e.g. "NYC"
  readings: LoopReading[]; // one entry per source that succeeded this tick
}

/** Turns a `LoopContext` into a friendly Discord message. `LocalTemplateFormatter` and
 *  `BedrockFormatter` implement the same interface, so the writer's hot path does not
 *  change between local and deployed. The LLM is given `date`, `location`, and
 *  `readings`; the writer mechanically appends the "Reminds me of" suffix to the
 *  formatter's output after the RAG lookup, so the formatter never sees the closest
 *  past reading. */
export interface MessageFormatter {
  format(ctx: LoopContext): Promise<string>;
}
```

- [ ] **Step 2: Run typecheck to confirm the new shape compiles**

Run: `npm run typecheck`
Expected: FAIL — `LoopContext` is now required by `MessageFormatter.format`, but `LocalTemplateFormatter` and `BedrockFormatter` still have the old `(source, value, similarPast)` signature. This is expected; Tasks 4 and 5 fix the call sites and the formatter implementations.

- [ ] **Step 3: Commit**

```bash
git add src/format/types.ts
git commit -m "refactor(format): introduce LoopContext, remove SimilarPastResult"
```

---

## Task 4: Update `LocalTemplateFormatter` to the new signature

**Files:**
- Modify: `src/format/local.ts`
- Test: `tests/format.test.ts`

- [ ] **Step 1: Update `tests/format.test.ts` for the new signature**

Replace `tests/format.test.ts` (currently 24 lines) with the following:

```typescript
// tests/format.test.ts
import { describe, expect, it } from 'vitest';
import { createLocalTemplateFormatter } from '../src/format/local.js';

const ctx = (readings: Array<{ source: 'weather' | 'crypto'; value: string }>, date = '2026-08-09', location = 'NYC') => ({
  date,
  location,
  readings,
});

describe('LocalTemplateFormatter', () => {
  it('formats a single weather reading with date and location', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format(ctx([{ source: 'weather', value: '72F' }]));
    expect(message).toBe('2026-08-09 — NYC — weather: 72F');
  });

  it('formats a single crypto reading with date and location', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format(ctx([{ source: 'crypto', value: '67234.10' }]));
    expect(message).toBe('2026-08-09 — NYC — crypto: 67234.10');
  });

  it('joins multiple readings with comma separators', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format(
      ctx([
        { source: 'weather', value: '72F' },
        { source: 'crypto', value: '67234.10' },
      ]),
    );
    expect(message).toBe('2026-08-09 — NYC — weather: 72F, crypto: 67234.10');
  });

  it('produces the same output for the same input across calls', async () => {
    const formatter = createLocalTemplateFormatter();
    const first = await formatter.format(ctx([{ source: 'weather', value: '72F' }]));
    const second = await formatter.format(ctx([{ source: 'weather', value: '72F' }]));
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/format.test.ts`
Expected: FAIL — `createLocalTemplateFormatter().format(ctx)` calls the old signature.

- [ ] **Step 3: Update `src/format/local.ts`**

Replace `src/format/local.ts` (currently 13 lines) with the following:

```typescript
import type { LoopContext, MessageFormatter } from './types.js';

/** Deterministic, no-AWS `MessageFormatter` for local runs (spec §9). Emits a
 *  `"{date} — {location} — {source}: {value}, ..."` shape — one segment per reading
 *  in input order. Source-agnostic: a third source added per `docs/04-extending.md`
 *  shows up in the output automatically. Not expected to generate a haiku — it's a
 *  test-only stub. Never used in the deployed Lambda — `BedrockFormatter` is the
 *  default there (`src/handler.ts`). */
export function createLocalTemplateFormatter(): MessageFormatter {
  return {
    async format(ctx: LoopContext): Promise<string> {
      const segments = ctx.readings.map((r) => `${r.source}: ${r.value}`).join(', ');
      return `${ctx.date} — ${ctx.location} — ${segments}`;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/format.test.ts`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/format/local.ts tests/format.test.ts
git commit -m "refactor(format): local template uses LoopContext, drops LABELS"
```

---

## Task 5: Update `BedrockFormatter` to the new signature and haiku prompt

**Files:**
- Modify: `src/format/bedrock.ts`
- Test: `tests/bedrock.test.ts`

- [ ] **Step 1: Update `tests/bedrock.test.ts` for the new signature and prompt**

Replace `tests/bedrock.test.ts` (currently 177 lines) with the following. The "closest past reading" tests are removed (the LLM is no longer asked about RAG); the new shape is `(ctx: LoopContext)` and the system prompt is the haiku-instruction string from spec §4.3.

```typescript
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBedrockFormatter } from '../src/format/bedrock.js';
import type { LoopContext } from '../src/format/types.js';

const bedrock = mockClient(BedrockRuntimeClient);

function textResponse(text: string) {
  return {
    output: { message: { role: 'assistant' as const, content: [{ text }] } },
    stopReason: 'end_turn' as const,
  };
}

function emptyResponse() {
  return {
    output: { message: { role: 'assistant' as const, content: [] as never[] } },
    stopReason: 'end_turn' as const,
  };
}

const ctx: LoopContext = {
  date: '2026-08-09',
  location: 'NYC',
  readings: [{ source: 'weather', value: '72F' }],
};

describe('createBedrockFormatter', () => {
  beforeEach(() => bedrock.reset());
  afterEach(() => bedrock.reset());

  const client = new BedrockRuntimeClient({ region: 'us-east-1' });

  it('calls Converse with the configured model id and returns the response text', async () => {
    bedrock.on(ConverseCommand).resolves(textResponse('A short friendly comment.\n\nA haiku here.'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    const message = await formatter.format(ctx);
    expect(message).toBe('A short friendly comment.\n\nA haiku here.');

    const calls = bedrock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input?.modelId).toBe('zai.glm-4.7-flash');
  });

  it('prepends the family default inference-profile prefix (anthropic.claude → global.)', async () => {
    // spec §12.3: anthropic.claude-* requires a `global.` (or `us.`) inference-profile
    // prefix. Without it, Bedrock returns ResourceNotFoundException even when the base
    // id is valid. The base id is configured; the prefix is supplied by the family.
    bedrock.on(ConverseCommand).resolves(textResponse('from claude'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await formatter.format(ctx);

    const calls = bedrock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input?.modelId).toBe(
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  it('uses the haiku-instruction system prompt and includes the LoopContext fields in the user message', async () => {
    bedrock.on(ConverseCommand).resolves(textResponse('ok'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await formatter.format({
      date: '2026-08-09',
      location: 'NYC',
      readings: [
        { source: 'weather', value: '72F' },
        { source: 'crypto', value: '67234.10' },
      ],
    });

    const calls = bedrock.commandCalls(ConverseCommand);
    const input = calls[0]?.args[0].input;

    // System prompt asks for a haiku — the LLM is never told about RAG.
    const systemText = input?.system?.[0]?.text ?? '';
    expect(systemText).toMatch(/haiku/i);
    expect(systemText).not.toMatch(/closest past reading/i);

    // User message carries date, location, and per-source readings.
    const userText = input?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(userText).toContain('2026-08-09');
    expect(userText).toContain('NYC');
    expect(userText).toContain('weather');
    expect(userText).toContain('72F');
    expect(userText).toContain('crypto');
    expect(userText).toContain('67234.10');
  });

  it('throws a descriptive error on AccessDeniedException', async () => {
    bedrock.on(ConverseCommand).rejects({ name: 'AccessDeniedException', message: 'denied' });

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format(ctx)).rejects.toThrow(/model access/i);
  });

  it('throws a descriptive error on ResourceNotFoundException naming the model id and region', async () => {
    bedrock.on(ConverseCommand).rejects({ name: 'ResourceNotFoundException', message: 'not found' });

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format(ctx)).rejects.toThrow(/zai\.glm-4\.7-flash/);
    await expect(formatter.format(ctx)).rejects.toThrow(/us-east-1/);
  });

  it('throws on a malformed response with no content, no retry', async () => {
    bedrock.on(ConverseCommand).resolves(emptyResponse());

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format(ctx)).rejects.toThrow(/no text/i);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
  });

  it('retries once on ThrottlingException, then succeeds', async () => {
    bedrock
      .on(ConverseCommand)
      .rejectsOnce({ name: 'ThrottlingException', message: 'slow down' })
      .resolves(textResponse('formatted after retry'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    const message = await formatter.format(ctx);
    expect(message).toBe('formatted after retry');
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('retries once on ThrottlingException, then throws if it fails again', async () => {
    bedrock.on(ConverseCommand).rejects({ name: 'ThrottlingException', message: 'slow down' });

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format(ctx)).rejects.toThrow(/Throttl/);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/bedrock.test.ts`
Expected: FAIL — `formatter.format(ctx)` is the new signature; current `format()` still takes `(source, value, similarPast?)`.

- [ ] **Step 3: Update `src/format/bedrock.ts`**

Replace `src/format/bedrock.ts` (currently 132 lines) with the following:

```typescript
import { type BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { resolveFamily } from './families.js';
import type { LoopContext, MessageFormatter } from './types.js';

export interface BedrockFormatterOptions {
  client: BedrockRuntimeClient;
  modelId: string;
  region: string;
  maxOutputTokens: number;
}

const RETRY_DELAY_MS = 500;

/**
 * Composes the wire id from the configured base id and the family's default prefix
 * (spec §12.3). The base id alone is not always valid: `anthropic.claude-*` requires
 * a `global.` (or `us.`) inference-profile prefix, and bare-form `amazon.nova-*` does
 * not. `zai.*` accepts the bare form (empty prefix), so for the default model this is
 * a no-op. `resolveFamily` is called again here (after `loadConfig` validates it at
 * startup) so the formatter owns the prefix-composition step rather than requiring
 * `loadConfig` to pre-compose.
 */
function composedModelId(baseModelId: string): string {
  const family = resolveFamily(baseModelId);
  const prefix = family.prefixes[0] ?? '';
  return `${prefix}${baseModelId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The LLM writes a short friendly comment and a closing haiku. The LLM is *not* told
 * about RAG — the "Reminds me of" suffix is appended mechanically in the writer after
 * the format call returns (loop-mode + poetic-closing spec §4.3). Numerology is
 * deliberately out: the LLM produces cliché numerology platitudes, while a haiku
 * gives the model real creative room and reads as varied across runs.
 */
const SYSTEM_PROMPT =
  'You write a short, friendly Discord message for a check-in bot that posts a ' +
  'combined snapshot of a few tracked values every few minutes. The user ' +
  'message below contains today\'s date, the location, and the current value ' +
  'of each tracked reading. Write a brief comment (one or two sentences) that ' +
  'draws on these inputs — vary your phrasing across runs; do not repeat the ' +
  'same template. End with a short haiku (three lines, 5-7-5 syllables) that ' +
  'weaves in the readings and the day\'s vibe. ' +
  'Reply with the message text only — no quotes, no preamble, no markdown.';

function buildUserPrompt(ctx: LoopContext): string {
  const lines = [
    `Date: ${ctx.date}`,
    `Location: ${ctx.location}`,
    ...ctx.readings.map((r) => `${r.source}: ${r.value}`),
  ];
  return lines.join('\n');
}

/** Maps a Bedrock exception to a message naming the fix (spec §6, §12.4). */
function mapBedrockError(error: unknown, options: BedrockFormatterOptions): Error {
  const { modelId, region } = options;
  const where = `model "${modelId}", region ${region}`;
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name ?? 'UnknownError';
  const detail = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);

  switch (name) {
    case 'AccessDeniedException':
      return new Error(
        `Bedrock model access is not granted for ${where}. Enable the model in the ` +
          `Bedrock console's Model access page for this account and region (spec §12.1). ` +
          `Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ValidationException':
      return new Error(
        `Bedrock rejected the request for ${where}. This is almost always a model-family ` +
          `mismatch (spec §12.3) — re-probe the model's accepted request shape before ` +
          `changing src/format/families.ts. Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ResourceNotFoundException':
      return new Error(
        `Bedrock does not recognise the model id for ${where}. Check that bedrockModelId ` +
          `is the base id with no inference-profile prefix — the prefix is supplied by the ` +
          `family (spec §12.3). Underlying error: ${detail}`,
        { cause: error },
      );
    default:
      return new Error(`Bedrock call failed for ${where} with ${name}: ${detail}`, { cause: error });
  }
}

function isThrottlingOr5xx(error: unknown): boolean {
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name;
  return name === 'ThrottlingException' || name === 'InternalServerException' || name === 'ServiceUnavailableException';
}

/**
 * `MessageFormatter` backed by Amazon Bedrock's Converse API (spec §2, §12). Default
 * model is `zai.glm-4.7-flash`, resolved and validated by `src/config.ts` at load time.
 *
 * One retry on `ThrottlingException`/5xx with a fixed ~500ms backoff (spec §6); every
 * other exception is not retried — access and validation failures are not transient.
 */
export function createBedrockFormatter(options: BedrockFormatterOptions): MessageFormatter {
  async function attempt(ctx: LoopContext): Promise<string> {
    const response = await options.client.send(
      new ConverseCommand({
        modelId: composedModelId(options.modelId),
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: buildUserPrompt(ctx) }] }],
        inferenceConfig: { maxTokens: options.maxOutputTokens },
      }),
    );

    const text = (response.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
    if (text === '') {
      throw new Error(`Bedrock returned no text (stopReason: ${response.stopReason ?? 'unknown'})`);
    }
    return text;
  }

  return {
    async format(ctx: LoopContext): Promise<string> {
      try {
        return await attempt(ctx);
      } catch (error: unknown) {
        if (isThrottlingOr5xx(error)) {
          await delay(RETRY_DELAY_MS);
          try {
            return await attempt(ctx);
          } catch (retryError: unknown) {
            throw mapBedrockError(retryError, options);
          }
        }
        if (error instanceof Error && error.message.startsWith('Bedrock returned no text')) {
          throw error; // malformed response — not retried, message is already descriptive
        }
        throw mapBedrockError(error, options);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/bedrock.test.ts`
Expected: PASS — all eight cases.

- [ ] **Step 5: Commit**

```bash
git add src/format/bedrock.ts tests/bedrock.test.ts
git commit -m "feat(format): Bedrock formatter uses LoopContext, system prompt asks for haiku"
```

---

## Task 6: Restructure `runFetch` to the combined-message, two-step RAG flow

**Files:**
- Modify: `src/agent/fetch.ts`
- Test: `tests/fetch.test.ts`

This is the biggest single change in the plan. The signature gains `weatherLocation: string`; the per-source loop is replaced with: fetch all → skip if all-failed → format once → embed LLM output → KNN → append suffix → post once → per-source inserts reusing the pre-vector. The test file is rewritten to match.

- [ ] **Step 1: Replace `tests/fetch.test.ts`**

Replace `tests/fetch.test.ts` (currently 366 lines) with the following. The new file uses an `IncrementClock` fake `now()` so the snowball test can drive 20 ticks and assert the RAG corpus is fresh each tick.

```typescript
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
    expect(r2Ctx?.date).toBe('1970-01-01'); // epoch date — this stub doesn't override `now`
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/fetch.test.ts`
Expected: FAIL — `runFetch` does not yet accept `weatherLocation`, still has the per-source loop, and the helper imports won't resolve.

- [ ] **Step 3: Replace `src/agent/fetch.ts`**

Replace `src/agent/fetch.ts` (currently 182 lines) with the following:

```typescript
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { bootstrap } from '../db/bootstrap.js';
import { openDatabase } from '../db/open.js';
import type { Embedder } from '../embed/titan.js';
import type { DiscordPoster } from '../discord/poster.js';
import type { LoopContext, MessageFormatter } from '../format/types.js';
import { findNearestMatch, insertEmbedding } from '../rag/similarity.js';
import type { SourceFetcher, SourceName } from '../sources/types.js';
import type { Store } from '../store/types.js';
import { finishRun, startRun } from './runLog.js';

export interface RunFetchParams {
  dbPath: string;
  store: Store;
  storeKey: string;
  sources: SourceFetcher[];
  poster: DiscordPoster;
  formatter: MessageFormatter;
  embedder: Embedder;
  /** The configured location (e.g. "NYC") — passed through to the `LoopContext` so the
   *  LLM can weave it into the friendly comment and haiku. Loop-mode + poetic-closing
   *  spec §4.4. */
  weatherLocation: string;
  runId?: string;
  now?: () => number;
}

export interface RunFetchResult {
  outcome: 'success' | 'error';
  sourcesChecked: number;
  notificationsSent: number;
  error: string | null;
}

/**
 * The writer op (spec §3.1, loop-mode + poetic-closing spec §4.4). Hydrates from the
 * store, runs bootstrap, fetches every source, formats ONCE with a `LoopContext`,
 * embeds the LLM's pre-suffix output ONCE, runs a global KNN lookup, appends a
 * mechanical "Reminds me of" suffix if a match exists, posts ONCE, writes per-source
 * `agent_notifications` rows (each with the same combined `formatted_message` /
 * `base_message` / `nearest_match_id`), reuses the pre-vector to insert per-source
 * embeddings, and publishes the snapshot back with a conditional write.
 *
 * Per-source failures (fetch only — there is no per-source formatter or post)
 * are caught individually and folded into `agent_runs.error`; the run still completes
 * and outcome stays `'success'`. Tick-level failures (formatter, embed, post) are
 * caught and the rest of the tick is skipped. Only a `PreconditionFailedError` from
 * the final publish propagates — that is an abort, not a tick-level failure.
 */
export async function runFetch(params: RunFetchParams): Promise<RunFetchResult> {
  const runId = params.runId ?? randomUUID();
  const now = params.now ?? (() => Date.now());

  // Step 1: hydrate.
  const existing = await params.store.get(params.storeKey);
  if (existing !== null) {
    writeFileSync(params.dbPath, existing.body);
  }
  const priorEtag: string | null = existing?.etag ?? null;

  // Step 2-3: open and bootstrap. Bootstrap is idempotent, so this is correct whether the
  // file was just hydrated or is a fresh empty file (spec §4.1).
  const db: Database.Database = openDatabase(params.dbPath);
  bootstrap(db);

  // Step 4: start the run record.
  startRun(db, {
    runId,
    op: 'fetch',
    snapshotVersionIn: priorEtag ?? 'none',
    startedAt: now(),
  });

  const errors: string[] = [];

  // Step 5: per-source fetch. Per-source failures are caught individually; the live
  // readings feed step 7's LoopContext.
  const readings = new Map<SourceName, string>();
  for (const source of params.sources) {
    try {
      readings.set(source.name, await source.fetch());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    }
  }

  // Step 6: if every source failed, the rest of the tick is a no-op.
  if (readings.size === 0) {
    finishRun(db, {
      runId,
      endedAt: now(),
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; ') || null,
    });
    db.close();

    const body = readFileSync(params.dbPath);
    try {
      await params.store.put(params.storeKey, body, priorEtag);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const dbForFailure = openDatabase(params.dbPath);
      finishRun(dbForFailure, {
        runId,
        endedAt: now(),
        outcome: 'error',
        sourcesChecked: params.sources.length,
        notificationsSent: 0,
        error: errors.length > 0 ? `${errors.join('; ')}; ${message}` : message,
      });
      dbForFailure.close();
      throw error;
    }

    return {
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; ') || null,
    };
  }

  // Step 7: build LoopContext and format ONCE (no RAG fields). A formatter failure
  // skips the rest of the tick.
  const loopContext: LoopContext = {
    date: new Date(now()).toISOString().slice(0, 10),
    location: params.weatherLocation,
    readings: [...readings.entries()].map(([source, value]) => ({ source, value })),
  };

  let preMessage: string;
  try {
    preMessage = await params.formatter.format(loopContext);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`formatter: ${message}`);
    finishRun(db, {
      runId,
      endedAt: now(),
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; '),
    });
    db.close();
    return publish(db, params, priorEtag, runId, now, 0, errors);
  }

  // Step 8: two-step RAG. Embed the LLM's pre-suffix output ONCE for the tick, then
  // run a global KNN lookup. A failure here skips the suffix but keeps the post.
  let preVector: number[] | null = null;
  type RAGMatch = { notificationId: number; distance: number; baseMessage: string; postedAt: number };
  let match: RAGMatch | null = null;
  try {
    preVector = await params.embedder.embed(preMessage);
    match = findNearestMatch(db, preVector);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`rag: ${message}`);
    // preVector stays null — step 13's embedding insert is skipped for this tick.
  }

  // Step 9: build the final message. The suffix is built from past base_message
  // (never past formatted_message), so the chain cannot snowball.
  const finalMessage =
    match !== null ? `${preMessage}\n\nReminds me of: ${match.baseMessage}` : preMessage;

  // Step 10: post once.
  try {
    await params.poster.post(finalMessage);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`post: ${message}`);
    finishRun(db, {
      runId,
      endedAt: now(),
      outcome: 'success',
      sourcesChecked: params.sources.length,
      notificationsSent: 0,
      error: errors.join('; '),
    });
    db.close();
    return publish(db, params, priorEtag, runId, now, 0, errors);
  }

  // Step 11: per-source DB writes. agent_sources must be upserted BEFORE
  // agent_notifications, because the latter has a FK on the former.
  const postedAt = now();
  for (const [sourceName, value] of readings) {
    db.prepare(
      `INSERT INTO agent_sources (name, last_value, last_fetched_at, last_posted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_value = excluded.last_value,
         last_fetched_at = excluded.last_fetched_at,
         last_posted_at = excluded.last_posted_at`,
    ).run(sourceName, value, postedAt, postedAt);

    const insertResult = db
      .prepare(
        `INSERT INTO agent_notifications
           (source, value, formatted_message, base_message, posted_at,
            nearest_match_id, nearest_match_distance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceName,
        value,
        finalMessage,
        preMessage,
        postedAt,
        match?.notificationId ?? null,
        match?.distance ?? null,
      );

    // Step 12: per-source embedding insert. Reuses preVector — no second Titan call.
    // Per-source insert failures are caught individually so the notification row
    // committed in step 11 stays.
    if (preVector !== null) {
      try {
        insertEmbedding(db, Number(insertResult.lastInsertRowid), preVector);
      } catch (storeError: unknown) {
        const message = storeError instanceof Error ? storeError.message : String(storeError);
        errors.push(`${sourceName} (embedding store): ${message}`);
      }
    }
  }

  // Step 13: finish the run record. One combined post per tick, regardless of how many
  // sources contributed.
  const errorText = errors.length > 0 ? errors.join('; ') : null;
  finishRun(db, {
    runId,
    endedAt: now(),
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent: 1,
    error: errorText,
  });

  db.close();

  // Step 14: conditional publish. A PreconditionFailedError here is an abort, not a
  // tick-level failure (spec §4.2).
  const body = readFileSync(params.dbPath);
  try {
    await params.store.put(params.storeKey, body, priorEtag);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const dbForFailure = openDatabase(params.dbPath);
    finishRun(dbForFailure, {
      runId,
      endedAt: now(),
      outcome: 'error',
      sourcesChecked: params.sources.length,
      notificationsSent: 1,
      error: errorText === null ? message : `${errorText}; ${message}`,
    });
    dbForFailure.close();
    throw error;
  }

  return {
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent: 1,
    error: errorText,
  };
}

/**
 * Short-circuits the publish step for tick-level failures — reopens the DB, closes it,
 * and returns the standard RunFetchResult. The early-return paths in `runFetch` use
 * this so the conditional-publish logic only lives in one place.
 */
function publish(
  db: Database.Database,
  params: RunFetchParams,
  priorEtag: string | null,
  runId: string,
  now: () => number,
  notificationsSent: number,
  errors: string[],
): Promise<RunFetchResult> {
  db.close();
  const body = readFileSync(params.dbPath);
  return params.store
    .put(params.storeKey, body, priorEtag)
    .then(() => ({
      outcome: 'success' as const,
      sourcesChecked: params.sources.length,
      notificationsSent,
      error: errors.length > 0 ? errors.join('; ') : null,
    }))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const dbForFailure = openDatabase(params.dbPath);
      finishRun(dbForFailure, {
        runId,
        endedAt: now(),
        outcome: 'error',
        sourcesChecked: params.sources.length,
        notificationsSent,
        error: errors.length > 0 ? `${errors.join('; ')}; ${message}` : message,
      });
      dbForFailure.close();
      throw error;
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/fetch.test.ts`
Expected: PASS — all twelve cases.

- [ ] **Step 5: Commit**

```bash
git add src/agent/fetch.ts tests/fetch.test.ts
git commit -m "feat(fetch): combined-message + two-step RAG + base_message separation"
```

---

## Task 7: Wire `weatherLocation` through `localFetch` and `handler`

**Files:**
- Modify: `src/localFetch.ts`
- Modify: `src/handler.ts`

- [ ] **Step 1: Update `src/localFetch.ts`**

Replace `src/localFetch.ts` (currently 30 lines) with the following:

```typescript
import { loadConfig } from './config.js';
import { runFetch } from './agent/fetch.js';
import { createLocalEmbedder } from './embed/local.js';
import { createLocalTemplateFormatter } from './format/local.js';
import { createFetchDiscordPoster } from './discord/poster.js';
import { createSourceFetcher } from './sources/index.js';
import { createLocalStore } from './store/local.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = createLocalStore('/tmp/sqlite-s3-agent-tutorial-store');

  const result = await runFetch({
    dbPath: config.dbPath,
    store,
    storeKey: 'memory.db',
    sources: config.sources.map((name) => createSourceFetcher(name, config.weatherLocation)),
    poster: createFetchDiscordPoster(config.discordWebhookUrl),
    formatter: createLocalTemplateFormatter(),
    embedder: createLocalEmbedder(),
    weatherLocation: config.weatherLocation,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Update `src/handler.ts`**

In `src/handler.ts`, find the `runFetch({ ... })` call site (one place — the `fetch` branch of the `runHandler` function). Replace the existing block:

```typescript
  const result = await runFetch({
    dbPath: config.dbPath,
    store,
    storeKey: config.snapshotKey,
    sources,
    poster: createFetchDiscordPoster(config.discordWebhookUrl),
    formatter,
    embedder,
  });
```

with:

```typescript
  const result = await runFetch({
    dbPath: config.dbPath,
    store,
    storeKey: config.snapshotKey,
    sources,
    poster: createFetchDiscordPoster(config.discordWebhookUrl),
    formatter,
    embedder,
    weatherLocation: config.weatherLocation,
  });
```

(`weatherLocation: config.weatherLocation` is the only addition — the rest of the call site is unchanged.)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — both call sites now pass `weatherLocation`.

- [ ] **Step 4: Commit**

```bash
git add src/localFetch.ts src/handler.ts
git commit -m "feat(fetch): thread weatherLocation through localFetch and handler"
```

---

## Task 8: Update handler tests for "ONE formatter call per tick"

**Files:**
- Modify: `tests/handler.test.ts`

- [ ] **Step 1: Update the multi-source assertion**

The existing test `'runs an HTTP-triggered fetch when the token matches'` already mocks `ConverseCommand`. The existing single-source assertions (`'routes op="fetch" through the writer and returns 200'`, `'routes op="status" through the reader …'`, `'runs an HTTP-triggered fetch when the token matches'`, `'runs an EventBridge-triggered fetch …'`) all use `SOURCES: '["weather"]'` — formatter call count is 1 in both old and new designs, so they don't need to change.

Add one new test that asserts ONE formatter call across two sources (the new spec's "one combined message per tick" guarantee at the handler level). Append it inside the `describe('runHandler', ...)` block, after the existing `'runs an EventBridge-triggered fetch regardless of FETCH_TRIGGER_TOKEN …'` test:

```typescript
  it('makes exactly one Converse call per tick even with two sources configured', async () => {
    s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' }); // bootstrap
    s3.on(PutObjectCommand).resolves({ ETag: '"v1"' });
    bedrock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: 'A short friendly comment.\n\nA haiku here.' }] } },
      stopReason: 'end_turn',
    });

    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
      DB_PATH: join(dir, 'memory.db'),
      SOURCES: '["weather", "crypto"]',
    };

    const result = await runHandler(
      { op: 'fetch' },
      env,
      { s3Client: s3 as unknown as S3Client, bedrockClient: bedrock as unknown as BedrockRuntimeClient },
      {
        weather: async () => '72F',
        crypto: async () => '67234.10',
      },
    );

    expect(result.statusCode).toBe(200);
    // The combined-message reformulation means exactly one formatter call per tick,
    // regardless of source count — the per-source loop is gone.
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm test -- tests/handler.test.ts`
Expected: PASS — all existing tests continue to pass, and the new test asserts the new "one Converse call per tick" semantics.

- [ ] **Step 3: Commit**

```bash
git add tests/handler.test.ts
git commit -m "test(handler): assert one Converse call per tick with two sources"
```

---

## Task 9: Update `infra/stack.ts` — schedule, output, timeout

**Files:**
- Modify: `infra/stack.ts`

- [ ] **Step 1: Change the schedule to 5 minutes**

In `src/handler.ts` (no — actually `infra/stack.ts`), find the `new events.Rule(this, 'FetchSchedule', { ... })` block. Replace the `schedule:` line:

```typescript
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
```

(Replaces the existing `events.Schedule.rate(cdk.Duration.days(1))`. No other change inside the `Rule` block — `enabled: true` stays, the autogenerated `ruleName` is unchanged, the `targets` block and `retryAttempts: 0` stay.)

- [ ] **Step 2: Bump the Lambda timeout to 60 seconds**

In the `agentFunction = new lambda.DockerImageFunction(this, 'AgentFunction', { ... })` block, replace the `timeout:` line:

```typescript
      timeout: cdk.Duration.seconds(60),
```

(Replaces the existing `timeout: cdk.Duration.seconds(30)`.)

- [ ] **Step 3: Add the `LoopRuleName` `CfnOutput`**

The `FetchSchedule` rule is referenced at construction (`new events.Rule(this, 'FetchSchedule', { ... })`). To add an output that references `ruleName`, the rule reference must be captured. Change the rule construction to:

```typescript
    const fetchSchedule = new events.Rule(this, 'FetchSchedule', {
      enabled: true,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new targets.LambdaFunction(agentFunction, {
          event: events.RuleTargetInput.fromObject({ op: 'fetch' }),
          // Spec §6: EventBridge retries on invocation failure are disabled for this op
          // — the failure is informational, not transient. Without this, CDK's default
          // is 185 retries over ~24 hours, and a 412 from Store.put would replay.
          retryAttempts: 0,
        }),
      ],
    });
```

Then append a new `CfnOutput` after the existing three outputs (after `AgentFunctionUrl`):

```typescript
    new cdk.CfnOutput(this, 'LoopRuleName', { value: fetchSchedule.ruleName });
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — `fetchSchedule` is the rule's `events.Rule` instance, and `ruleName` is a public string property on it.

- [ ] **Step 5: Commit**

```bash
git add infra/stack.ts
git commit -m "feat(infra): 5-min schedule, LoopRuleName output, 60s lambda timeout"
```

---

## Task 10: Create `scripts/loop-start.sh` and `scripts/loop-stop.sh`

**Files:**
- Create: `scripts/loop-start.sh`
- Create: `scripts/loop-stop.sh`

- [ ] **Step 1: Create `scripts/loop-stop.sh`**

Create `scripts/loop-stop.sh` with the following contents:

```bash
#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

echo "=== Fetching loop rule name ==="
RULE_NAME=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='LoopRuleName'].OutputValue" \
  --output text)

if [ -z "$RULE_NAME" ] || [ "$RULE_NAME" = "None" ]; then
  echo "FAIL: stack $STACK_NAME has no LoopRuleName output — is the loop feature already deployed?" >&2
  exit 1
fi

echo "Rule: $RULE_NAME"

echo ""
echo "=== Disabling loop rule ==="
aws events disable-rule \
  --name "$RULE_NAME" \
  --profile "$PROFILE" \
  --region "$REGION"

echo ""
echo "=== Confirming rule state ==="
STATE=$(aws events describe-rule \
  --name "$RULE_NAME" \
  --query State \
  --output text \
  --profile "$PROFILE" \
  --region "$REGION")

echo "Rule $RULE_NAME is now: $STATE"
echo ""
echo "Note: running 'npm run deploy' after this script re-enables the rule, since the"
echo "CDK stack declares it 'enabled: true'. Re-run this script after any redeploy if"
echo "you want the loop to stay off."
```

- [ ] **Step 2: Create `scripts/loop-start.sh`**

Create `scripts/loop-start.sh` with the following contents (mirror of `loop-stop.sh`, with `enable-rule` instead of `disable-rule`):

```bash
#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

echo "=== Fetching loop rule name ==="
RULE_NAME=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='LoopRuleName'].OutputValue" \
  --output text)

if [ -z "$RULE_NAME" ] || [ "$RULE_NAME" = "None" ]; then
  echo "FAIL: stack $STACK_NAME has no LoopRuleName output — is the loop feature already deployed?" >&2
  exit 1
fi

echo "Rule: $RULE_NAME"

echo ""
echo "=== Enabling loop rule ==="
aws events enable-rule \
  --name "$RULE_NAME" \
  --profile "$PROFILE" \
  --region "$REGION"

echo ""
echo "=== Confirming rule state ==="
STATE=$(aws events describe-rule \
  --name "$RULE_NAME" \
  --query State \
  --output text \
  --profile "$PROFILE" \
  --region "$REGION")

echo "Rule $RULE_NAME is now: $STATE"
```

- [ ] **Step 3: Make both scripts executable**

Run: `chmod +x scripts/loop-start.sh scripts/loop-stop.sh`
Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/loop-start.sh scripts/loop-stop.sh
git commit -m "feat(scripts): loop-start.sh and loop-stop.sh toggle EventBridge rule"
```

---

## Task 11: Add loop scripts to `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the two scripts**

In `package.json`, locate the `"scripts"` block. Add two new entries after the existing `"smoke"` line:

```json
    "loop-start": "bash scripts/loop-start.sh",
    "loop-stop": "bash scripts/loop-stop.sh",
```

The result (excerpt):

```json
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.check.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "local-fetch": "tsx src/localFetch.ts",
    "cdk": "cdk",
    "deploy": "bash scripts/deploy.sh",
    "smoke": "bash scripts/smoke.sh",
    "loop-start": "bash scripts/loop-start.sh",
    "loop-stop": "bash scripts/loop-stop.sh"
  },
```

- [ ] **Step 2: Install nothing; the scripts only use AWS CLI**

No `npm install` is needed — the AWS CLI is the only runtime dependency, and `smoke.sh` already requires it.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(package): expose loop-start and loop-stop npm scripts"
```

---

## Task 12: Add "Loop mode" subsection to `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Insert the new subsection**

In `README.md`, locate the `## Triggering a fetch on demand` section. Insert a new `## Loop mode` section immediately before it (after the `### Quick start` block). The new section reads:

```markdown
## Loop mode

For local testing and quick iteration, the agent can run a 5-minute loop instead of
the once-daily schedule. After the same `npm run deploy` as for the daily schedule,
toggle the loop on and off directly from your shell — no Lambda invocation, no token,
no extra IAM grants:

```bash
npm run loop-start   # calls `aws events enable-rule` on the deployed rule
npm run loop-stop    # calls `aws events disable-rule` — no further ticks
```

While the loop is running, each tick posts one combined Discord message: a short
friendly comment drawn from today's date, weather, and crypto price, ending with a
haiku. If a past message in the corpus is close enough, the LLM's pre-suffix output
is mechanically appended with a `Reminds me of: <past message>` line. Both scripts
read the rule name from the `LoopRuleName` stack output and call the EventBridge API
directly using the same AWS CLI credentials the smoke script already requires.

**Stop the loop when you're done** — `loop-stop.sh` disables the EventBridge rule so
no further invocations occur and the recurring AWS cost stops. Note: running
`npm run deploy` after `loop-stop.sh` re-enables the rule, since the CDK stack
declares it `enabled: true` — re-run `loop-stop.sh` after any redeploy if you want
the loop to stay off. See [docs/07-budget-protection.md](docs/07-budget-protection.md)
for the per-day Bedrock call rate at 5-min cadence.
```

- [ ] **Step 2: Run the markdown link check (manual)**

Search for broken internal links in `README.md`:

Run: `grep -n '\](\([^h]\|http\)' README.md`
Expected: the only links are to `docs/...` files and the existing table-of-contents entries — no broken references.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Loop mode subsection with start/stop scripts"
```

---

## Task 13: Add loop-cost paragraph to `docs/07-budget-protection.md`

**Files:**
- Modify: `docs/07-budget-protection.md`

- [ ] **Step 1: Insert a new bullet in "What can actually drive cost up"**

In `docs/07-budget-protection.md`, locate the `## What can actually drive cost up` bullet list. Add a fourth bullet immediately after the existing three bullets (the `SOURCES` / `BEDROCK_MAX_OUTPUT_TOKENS` one):

```markdown
- **Loop mode running unattended.** Switching the 5-minute loop on (`npm run loop-start`)
  drives ~576 Bedrock calls per day (1 Converse + 1 Titan per tick × 288 ticks/day) and
  grows both `agent_notifications` and `agent_embeddings` by ~576 rows each per day
  (~1,152 rows/day combined). At default model pricing this is roughly $0.02–$0.04/day,
  but a loop left running for a weekend amplifies the spend noticeably. `npm run
  loop-stop` disables the EventBridge rule so no further ticks fire — re-run it after
  any `npm run deploy` that re-enables the rule (see the redeploy caveat in the
  README's Loop mode section).
```

- [ ] **Step 2: Commit**

```bash
git add docs/07-budget-protection.md
git commit -m "docs(budget): note 5-min loop Bedrock-call rate and row growth"
```

---

## Task 14: Final verification

**Files:**
- (none — runs the full check suite)

- [ ] **Step 1: Run a clean install and full typecheck**

Run: `rm -rf node_modules && npm install && npm run typecheck`
Expected: install completes; `typecheck` exits 0 with no errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: every test file passes. The full list:

- `tests/bedrock.test.ts` — 8 cases
- `tests/config.test.ts` — unchanged
- `tests/db.test.ts` — existing cases + the new `base_message` test from Task 1
- `tests/discord.test.ts` — unchanged
- `tests/families.test.ts` — unchanged
- `tests/fetch.test.ts` — 12 cases (rewritten in Task 6)
- `tests/format.test.ts` — 4 cases (rewritten in Task 4)
- `tests/handler.test.ts` — existing cases + 1 new case from Task 8
- `tests/runLog.test.ts` — unchanged
- `tests/s3.test.ts` — unchanged
- `tests/similarity.test.ts` — 7 cases (rewritten in Task 2)
- `tests/status.test.ts` — unchanged
- `tests/store.test.ts` — unchanged
- `tests/titan.test.ts` — unchanged

- [ ] **Step 3: Confirm the local writer end-to-end**

Run: `set -a; . ./.env; set +a && npm run local-fetch`
Expected: a single-line JSON result with `outcome: "success"`, `notificationsSent: 1`,
and `error: null` (or with one source's actual error if the network is offline —
that's an environmental failure, not a code bug). The path of the local SQLite file
remains `/tmp/sqlite-s3-agent-tutorial-store/memory.db` after the run.

- [ ] **Step 4: Grep for placeholders**

Run: `grep -rn 'TBD\|TODO\|FIXME' src/ tests/ infra/ scripts/ docs/`
Expected: no new occurrences beyond comments that are pre-existing or that explicitly
mark deferred work (e.g. "out of scope per spec §9"). The spec's open concerns
(RAG corpus bloat, per-source dedup, etc.) are documented in the spec itself, not
left as code TODOs.

- [ ] **Step 5: Review the diff**

Run: `git log --oneline -14`
Expected: 14 commits, each one a self-contained change from the tasks above:

1. `feat(schema): add base_message column for snowball-free RAG suffix`
2. `feat(rag): global KNN returns baseMessage, filter null base_message`
3. `refactor(format): introduce LoopContext, remove SimilarPastResult`
4. `refactor(format): local template uses LoopContext, drops LABELS`
5. `feat(format): Bedrock formatter uses LoopContext, system prompt asks for haiku`
6. `feat(fetch): combined-message + two-step RAG + base_message separation`
7. `feat(fetch): thread weatherLocation through localFetch and handler`
8. `test(handler): assert one Converse call per tick with two sources`
9. `feat(infra): 5-min schedule, LoopRuleName output, 60s lambda timeout`
10. `feat(scripts): loop-start.sh and loop-stop.sh toggle EventBridge rule`
11. `chore(package): expose loop-start and loop-stop npm scripts`
12. `docs(readme): add Loop mode subsection with start/stop scripts`
13. `docs(budget): note 5-min loop Bedrock-call rate and row growth`

Run: `git diff main..HEAD --stat`
Expected: every file listed under "File Structure" at the top of this plan has at
least one changed line.

- [ ] **Step 6: Done**

The loop-mode + poetic-closing feature is implemented, documented, and test-covered.
`npm run typecheck && npm test` is green. The README and `docs/07-budget-protection.md`
carry the user-facing notes; the design spec remains the authoritative source for
what was built and why.
