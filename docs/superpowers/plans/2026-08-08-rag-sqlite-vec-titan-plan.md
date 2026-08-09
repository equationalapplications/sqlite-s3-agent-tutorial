# RAG via sqlite-vec + Titan Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tutorial's writer embed every notification it posts with Amazon Titan Text Embeddings V2, store the vectors in a `sqlite-vec` virtual table inside the same `memory.db` file, and mention the closest same-source past result — in the Bedrock-formatted Discord message and in the `status` JSON — demonstrating that SQLite (with the `sqlite-vec` loadable extension) can replace a vector database, not just a database server.

**Architecture:** Per source, per `fetch` run: embed today's raw value (query vector), KNN-search `agent_embeddings` for the closest prior same-source notification, fold that into the Bedrock prompt, post, insert the notification (recording which past row matched and at what distance), then embed the just-created `formatted_message` and store it for future lookups. Both embedding calls share the same per-source error isolation `runFetch` already has for fetch/format/post failures. The reader (`status`) never touches the vector table — it only reads the two new plain columns on `agent_notifications`.

**Tech Stack:** `sqlite-vec` (npm, loadable SQLite extension, JS API `sqliteVec.load(db)`), Amazon Bedrock `InvokeModel` against `amazon.titan-embed-text-v2:0`, `better-sqlite3` (already a dependency), `aws-sdk-client-mock` for Bedrock test doubles (already a devDependency).

**Design doc:** [docs/superpowers/specs/2026-08-08-rag-sqlite-vec-titan-design.md](../specs/2026-08-08-rag-sqlite-vec-titan-design.md)

**Verified against the actual `sqlite-vec` npm package (v0.1.9) before writing this plan:**
- JS API is `import * as sqliteVec from 'sqlite-vec'; sqliteVec.load(db);` — it internally calls `db.loadExtension(...)`, resolving a platform-specific prebuilt binary via `optionalDependencies` (`sqlite-vec-linux-arm64` etc.). `linux-arm64` is a supported platform, matching this repo's Docker build target.
- `better-sqlite3`'s `Database` constructor needs **no** `allowExtension` option — that flag belongs to Node's built-in `node:sqlite` module, a different library. `better-sqlite3`'s `loadExtension(path)` works with no extra constructor flags. (The design doc's §5 mentions `allowExtension: true`; that turned out to be incorrect on verification and is *not* used below.)
- `vec0` column syntax: `embedding FLOAT[256] distance_metric=cosine`.
- KNN query syntax: `WHERE embedding MATCH ? AND k = ?` (not `ORDER BY ... LIMIT`), where `?` for the vector is a JSON-array string.
- Insert syntax: `INSERT INTO t (rowid_col, vec_col) VALUES (?, vec_f32(?))`, with the vector again bound as a JSON-array string.

---

## File Structure

New files:
- `src/embed/titan.ts` — `Embedder` interface + `createTitanEmbedder()`, mirrors `src/format/bedrock.ts`.
- `src/embed/local.ts` — `createLocalEmbedder()`, a deterministic no-AWS `Embedder` mirroring `src/format/local.ts`. Used by `localFetch.ts` (Phase 1, no AWS) *and* by tests, instead of a separate test-only fake — one implementation, two callers.
- `src/rag/similarity.ts` — `findNearestMatch()` + `insertEmbedding()`, the only two functions that touch `agent_embeddings`.
- `tests/titan.test.ts`, `tests/similarity.test.ts` — new test files, same conventions as `tests/bedrock.test.ts` / `tests/db.test.ts`.
- `docs/08-rag-vector-search.md` — teaching doc (numbered `08`; `07` is already taken by `docs/07-budget-protection.md`).

Modified files:
- `src/db/schema.ts` — `agent_embeddings` vec0 table added to `AGENT_DDL`.
- `src/db/bootstrap.ts` — idempotent `ALTER TABLE` step adding `nearest_match_id`/`nearest_match_distance` to `agent_notifications`.
- `src/db/open.ts` — `openDatabase` (writer only) loads the `sqlite-vec` extension.
- `src/format/types.ts` — `MessageFormatter.format()` gains an optional `SimilarPastResult` third parameter.
- `src/format/bedrock.ts` — prompt gains an optional "closest past reading" line.
- `src/agent/fetch.ts` — the RAG flow (embed → match → format → post → insert → embed → store), fully error-isolated.
- `src/agent/status.ts` — `NotificationStatus` gains `nearestMatch`, sourced via a `LEFT JOIN`.
- `src/handler.ts`, `src/localFetch.ts` — construct and pass an `Embedder` into `runFetch`.
- `infra/stack.ts` — one more fixed Bedrock resource ARN for the Titan embedding model.
- `package.json` — new `sqlite-vec` dependency.
- `tests/db.test.ts`, `tests/fetch.test.ts`, `tests/status.test.ts`, `tests/bedrock.test.ts` — updated for the new schema/interfaces.
- `README.md` — doc table row for `docs/08-rag-vector-search.md`.
- `docs/01-architecture.md` — one sentence noting the Titan embedding calls alongside the existing Converse call.

---

### Task 1: Add the `sqlite-vec` dependency

**Files:**
- Modify: `package.json:19-23`

- [ ] **Step 1: Add the dependency**

In `package.json`, add `sqlite-vec` to `dependencies` (alphabetical order, matching the existing list):

```json
  "dependencies": {
    "better-sqlite3": "^13.0.1",
    "sqlite-vec": "^0.1.9",
    "@aws-sdk/client-bedrock-runtime": "^3.1103.0",
    "@aws-sdk/client-s3": "^3.1103.0"
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `sqlite-vec` and its platform-specific optional dependency (e.g. `sqlite-vec-darwin-arm64` on a Mac) appear in `package-lock.json` and `node_modules`.

- [ ] **Step 3: Verify the extension loads**

Run: `node -e "const Database = require('better-sqlite3'); const sqliteVec = require('sqlite-vec'); const db = new Database(':memory:'); sqliteVec.load(db); console.log(db.prepare('select vec_version()').get());"`
Expected: prints an object like `{ 'vec_version()': 'v0.1.9' }` with no error. This confirms the platform binary resolves and loads correctly on this machine *before* any application code depends on it.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add sqlite-vec dependency"
```

---

### Task 2: Schema — `agent_embeddings` vec0 table + `nearest_match` columns

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/bootstrap.ts`
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the top of `tests/db.test.ts` (imports and the `describe('schema DDL', ...)` block) with:

```typescript
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
    expect(() =>
      db
        .prepare(`INSERT INTO agent_embeddings (notification_id, embedding) VALUES (?, vec_f32(?))`)
        .run(notificationId, vector),
    ).not.toThrow();

    const row = db.prepare(`SELECT notification_id FROM agent_embeddings`).get() as { notification_id: number };
    expect(row.notification_id).toBe(notificationId);
    db.close();
  });
});
```

Leave the rest of `tests/db.test.ts` (the `bootstrap`, `openDatabase`, `openReadOnlyDatabase` describe blocks) as-is for now — Step 1 only adds/changes the `schema DDL` block. Now append a new describe block at the end of the file, right before the file's closing (after the `openReadOnlyDatabase` block):

```typescript

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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — `agent_embeddings` doesn't exist yet (`no such table: agent_embeddings`), `nearest_match_id`/`nearest_match_distance` aren't in `PRAGMA table_info`.

- [ ] **Step 3: Add `agent_embeddings` to `AGENT_DDL`**

In `src/db/schema.ts`, after the `agent_runs` table's closing `);` and before the closing template-literal backtick, add:

```sql

CREATE VIRTUAL TABLE IF NOT EXISTS agent_embeddings USING vec0(
  notification_id INTEGER PRIMARY KEY,
  embedding        FLOAT[256] distance_metric=cosine
);
```

The full updated `AGENT_DDL` constant:

```typescript
/** Closed vocabulary for `agent_sources.name` (spec §5). Extend by editing this array
 *  and the CHECK constraint below — the tutorial is intentionally narrow. */
export const SOURCE_NAMES = ['weather', 'crypto'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

/** DDL for all tables, including the `agent_embeddings` vector table (RAG design spec
 *  §3.1). Applied via `CREATE TABLE IF NOT EXISTS` / `CREATE VIRTUAL TABLE IF NOT
 *  EXISTS`, so re-running it against an already-bootstrapped database is a no-op (spec
 *  §4.1). Requires the `sqlite-vec` extension to already be loaded on the connection —
 *  `openDatabase` (src/db/open.ts) does this before `bootstrap()` runs. */
export const AGENT_DDL = `
CREATE TABLE IF NOT EXISTS agent_sources (
  name              TEXT PRIMARY KEY,
  last_value        TEXT,
  last_fetched_at   INTEGER,
  last_posted_at    INTEGER,
  CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto'))
);

CREATE TABLE IF NOT EXISTS agent_notifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source             TEXT    NOT NULL,
  value              TEXT    NOT NULL,
  formatted_message  TEXT    NOT NULL,
  posted_at          INTEGER NOT NULL,
  FOREIGN KEY (source) REFERENCES agent_sources(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_notifications_source_posted_at
  ON agent_notifications(source, posted_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id              TEXT PRIMARY KEY,
  op                  TEXT NOT NULL,
  snapshot_version_in TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  outcome             TEXT,
  sources_checked     INTEGER,
  notifications_sent  INTEGER,
  error               TEXT,
  CONSTRAINT chk_op      CHECK (op IN ('fetch', 'status')),
  CONSTRAINT chk_outcome CHECK (outcome IS NULL OR outcome IN ('success', 'error'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_embeddings USING vec0(
  notification_id INTEGER PRIMARY KEY,
  embedding        FLOAT[256] distance_metric=cosine
);
`;
```

Note: `nearest_match_id`/`nearest_match_distance` are deliberately **not** added to the `agent_notifications` block above — they're added via idempotent `ALTER TABLE` in `bootstrap()` instead (Step 4), so a database bootstrapped before this feature shipped upgrades in place on its next `fetch` run (design spec §3.2).

- [ ] **Step 4: Add the idempotent `ALTER TABLE` step to `bootstrap()`**

Replace the full contents of `src/db/bootstrap.ts`:

```typescript
import type Database from 'better-sqlite3';
import { AGENT_DDL } from './schema.js';

/** Creates the three agent tables plus `agent_embeddings`. Idempotent — safe to call on
 *  every writer invocation. */
export function bootstrap(db: Database.Database): void {
  db.exec(AGENT_DDL);
  addNearestMatchColumnsIfMissing(db);
}

/**
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so idempotency here is
 * implemented by checking `PRAGMA table_info` first. These two columns record which
 * past notification (if any) was the closest match at the time this notification was
 * posted (RAG design spec §3.2) — both nullable, since `NULL` legitimately means "no
 * prior notification for this source yet" or "the embedding/match step failed and was
 * isolated" (spec §6), not a placeholder to special-case.
 */
function addNearestMatchColumnsIfMissing(db: Database.Database): void {
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
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS, all cases including the new ones.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: All currently-passing tests still pass (some may now fail if they construct a raw `new Database()` and exec `AGENT_DDL` without loading the extension elsewhere in the suite — grep first: `grep -rn "AGENT_DDL" tests/` — as of this plan, `tests/db.test.ts` is the only file that does this).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/bootstrap.ts tests/db.test.ts
git commit -m "feat(rag): add agent_embeddings vec0 table and nearest_match columns"
```

---

### Task 3: `db/open.ts` — load the `sqlite-vec` extension in the writer

**Files:**
- Modify: `src/db/open.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/db.test.ts`, inside the existing `describe('openDatabase', ...)` block (after the two existing `it(...)` cases, before the closing `});`):

```typescript

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db.test.ts -t "loads the sqlite-vec extension"`
Expected: FAIL with `no such module: vec0`.

- [ ] **Step 3: Load the extension in `openDatabase`**

Replace the full contents of `src/db/open.ts`:

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Opens a file-backed SQLite database.
 *
 * DELETE journal mode, not WAL: the durable store is a single S3 object containing only
 * `memory.db` (spec §3.1 step 2). WAL keeps committed data in a sidecar `-wal` file, which
 * would make an S3 upload of `memory.db` alone silently omit the most recent writes.
 *
 * Foreign keys are enabled per connection (SQLite default is off). Without this,
 * `agent_notifications.source`'s `FOREIGN KEY ... ON DELETE CASCADE` is a no-op, and the
 * writer could insert orphan notification rows for sources that don't exist in
 * `agent_sources`.
 *
 * Loads the `sqlite-vec` extension (RAG design spec §5) — `bootstrap()`'s DDL includes a
 * `vec0` virtual table, which requires the extension to already be registered on this
 * connection. `better-sqlite3`'s `loadExtension` needs no constructor flag (unlike Node's
 * built-in `node:sqlite`, which does) — this was verified against the installed
 * `better-sqlite3` version before writing this. The reader (`openReadOnlyDatabase`,
 * below) deliberately does *not* load this extension: it never runs vector queries, only
 * plain-column reads.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Opens an existing SQLite file read-only. Used by the reader (spec §3.2): the reader's
 * IAM grant is GetObject-only (spec §2), so a read-only DB handle matches that intent even
 * though `better-sqlite3` itself has no knowledge of the S3 permission model.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/db/open.ts tests/db.test.ts
git commit -m "feat(rag): load sqlite-vec extension in the writer's database connection"
```

---

### Task 4: `src/embed/titan.ts` — Titan embedder

**Files:**
- Create: `src/embed/titan.ts`
- Create: `tests/titan.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/titan.test.ts`:

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTitanEmbedder } from '../src/embed/titan.js';

const bedrock = mockClient(BedrockRuntimeClient);

function embeddingResponse(embedding: number[]) {
  return {
    body: new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: embedding.length })),
    contentType: 'application/json',
  };
}

describe('createTitanEmbedder', () => {
  beforeEach(() => bedrock.reset());
  afterEach(() => bedrock.reset());

  const client = new BedrockRuntimeClient({ region: 'us-east-1' });

  it('calls InvokeModel with the Titan v2 model id, 256 dims, normalize, and returns the embedding', async () => {
    bedrock.on(InvokeModelCommand).resolves(embeddingResponse([0.1, 0.2, 0.3]));

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    const vector = await embedder.embed('72F');
    expect(vector).toEqual([0.1, 0.2, 0.3]);

    const calls = bedrock.commandCalls(InvokeModelCommand);
    expect(calls[0]?.args[0].input?.modelId).toBe('amazon.titan-embed-text-v2:0');
    const body = JSON.parse(calls[0]?.args[0].input?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ inputText: '72F', dimensions: 256, normalize: true });
  });

  it('throws a descriptive error on AccessDeniedException', async () => {
    bedrock.on(InvokeModelCommand).rejects({ name: 'AccessDeniedException', message: 'denied' });

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/model access/i);
  });

  it('retries once on ThrottlingException, then succeeds', async () => {
    bedrock
      .on(InvokeModelCommand)
      .rejectsOnce({ name: 'ThrottlingException', message: 'slow down' })
      .resolves(embeddingResponse([1, 2, 3]));

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    const vector = await embedder.embed('72F');
    expect(vector).toEqual([1, 2, 3]);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(2);
  });

  it('retries once on ThrottlingException, then throws if it fails again', async () => {
    bedrock.on(InvokeModelCommand).rejects({ name: 'ThrottlingException', message: 'slow down' });

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/Throttl/);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(2);
  });

  it('throws on a response with no embedding array, no retry', async () => {
    bedrock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(JSON.stringify({ inputTextTokenCount: 5 })),
      contentType: 'application/json',
    });

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/no embedding/i);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/titan.test.ts`
Expected: FAIL — `Cannot find module '../src/embed/titan.js'`.

- [ ] **Step 3: Implement `src/embed/titan.ts`**

Create `src/embed/titan.ts`:

```typescript
import { type BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface TitanEmbedderOptions {
  client: BedrockRuntimeClient;
  region: string;
}

/** Fixed — unlike the chat model (`bedrockModelId`, `src/format/families.ts`), the
 *  embedding model isn't configurable (RAG design spec §4.1): one model, one code path,
 *  no family-resolution branching. Changing it would mean re-embedding the whole corpus,
 *  a migration problem this tutorial doesn't need to teach. */
const MODEL_ID = 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 256;
const RETRY_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottlingOr5xx(error: unknown): boolean {
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name;
  return name === 'ThrottlingException' || name === 'InternalServerException' || name === 'ServiceUnavailableException';
}

/** Maps a Bedrock exception to a message naming the fix, mirroring
 *  `src/format/bedrock.ts`'s `mapBedrockError`. */
function mapTitanError(error: unknown, region: string): Error {
  const where = `model "${MODEL_ID}", region ${region}`;
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name ?? 'UnknownError';
  const detail = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);

  switch (name) {
    case 'AccessDeniedException':
      return new Error(
        `Bedrock model access is not granted for ${where}. Enable the model in the ` +
          `Bedrock console's Model access page for this account and region. ` +
          `Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ValidationException':
      return new Error(
        `Bedrock rejected the embedding request for ${where}. Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ResourceNotFoundException':
      return new Error(
        `Bedrock does not recognise the model id for ${where}. Underlying error: ${detail}`,
        { cause: error },
      );
    default:
      return new Error(`Bedrock embedding call failed for ${where} with ${name}: ${detail}`, { cause: error });
  }
}

/**
 * `Embedder` backed by Amazon Bedrock's `InvokeModel` API against Titan Text Embeddings
 * V2 (RAG design spec §4.1). Titan's embedding API is `InvokeModel`, not `Converse` —
 * `Converse` is for chat-turn models, which this isn't.
 *
 * One retry on `ThrottlingException`/5xx with a fixed ~500ms backoff, mirroring
 * `src/format/bedrock.ts`; every other exception is not retried.
 */
export function createTitanEmbedder(options: TitanEmbedderOptions): Embedder {
  async function attempt(text: string): Promise<number[]> {
    const response = await options.client.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text, dimensions: DIMENSIONS, normalize: true }),
      }),
    );

    const decoded = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(decoded) as { embedding?: unknown };
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
      throw new Error(`Titan returned no embedding for model "${MODEL_ID}"`);
    }
    return parsed.embedding as number[];
  }

  return {
    async embed(text: string): Promise<number[]> {
      try {
        return await attempt(text);
      } catch (error: unknown) {
        if (isThrottlingOr5xx(error)) {
          await delay(RETRY_DELAY_MS);
          try {
            return await attempt(text);
          } catch (retryError: unknown) {
            throw mapTitanError(retryError, options.region);
          }
        }
        if (error instanceof Error && error.message.startsWith('Titan returned no embedding')) {
          throw error; // malformed response — not retried, message is already descriptive
        }
        throw mapTitanError(error, options.region);
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/titan.test.ts`
Expected: PASS, all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/embed/titan.ts tests/titan.test.ts
git commit -m "feat(rag): add Titan Text Embeddings V2 embedder"
```

---

### Task 5: `src/embed/local.ts` — deterministic no-AWS embedder

**Files:**
- Create: `src/embed/local.ts`

This mirrors `src/format/local.ts` (`LocalTemplateFormatter`): a Phase-1, no-AWS stand-in so `runFetch`'s RAG step runs end-to-end without Bedrock. It's used by `localFetch.ts` *and* by tests in later tasks — no separate test-only fake is needed.

- [ ] **Step 1: Implement `src/embed/local.ts`**

Create `src/embed/local.ts`:

```typescript
import type { Embedder } from './titan.js';

const DIMENSIONS = 256;

/**
 * Deterministic, no-AWS `Embedder` for Phase 1 (mirrors `createLocalTemplateFormatter`
 * in `src/format/local.ts`). Not semantically meaningful — it's a character-code hash,
 * not a real embedding — but identical input text always produces an identical vector
 * (zero cosine distance), and different text produces different vectors, which is
 * enough for `runFetch`'s RAG step (embed, store, KNN-match) to run and be tested without
 * a Bedrock call. Never used in the deployed Lambda — `createTitanEmbedder` is the
 * default there (`src/handler.ts`).
 */
export function createLocalEmbedder(): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const vector = new Array(DIMENSIONS).fill(0) as number[];
      for (let i = 0; i < text.length; i++) {
        vector[i % DIMENSIONS] += text.charCodeAt(i);
      }
      return vector;
    },
  };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS (no test yet — this file is exercised indirectly by `tests/fetch.test.ts` and `tests/similarity.test.ts` in later tasks, and directly by nothing else, matching how `LocalTemplateFormatter` has no dedicated test file either).

- [ ] **Step 3: Commit**

```bash
git add src/embed/local.ts
git commit -m "feat(rag): add deterministic no-AWS embedder for Phase 1 and tests"
```

---

### Task 6: `src/rag/similarity.ts` — nearest-match lookup and storage

**Files:**
- Create: `src/rag/similarity.ts`
- Create: `tests/similarity.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/similarity.test.ts`:

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/similarity.test.ts`
Expected: FAIL — `Cannot find module '../src/rag/similarity.js'`.

- [ ] **Step 3: Implement `src/rag/similarity.ts`**

Create `src/rag/similarity.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { SourceName } from '../db/schema.js';

export interface NearestMatch {
  notificationId: number;
  distance: number;
  formattedMessage: string;
  postedAt: number;
}

/**
 * Fixed KNN scan size (RAG design spec §4.2) — generous for a once-daily tutorial's
 * history (50 rows is ~7 weeks across two sources), documented as a known ceiling rather
 * than engineered for arbitrary scale: past this ceiling, `findNearestMatch` can miss the
 * true nearest same-source neighbor if it isn't among the 50 closest across *all*
 * sources. Same pattern as `RECENT_NOTIFICATIONS_LIMIT` in `src/agent/status.ts`.
 */
const KNN_CANDIDATES = 50;

interface CandidateRow {
  notificationId: number;
  source: string;
  formattedMessage: string;
  postedAt: number;
  distance: number;
}

/**
 * Finds the closest same-source past notification to `queryVector`, or `null` if the
 * source has no embedded history yet. `agent_embeddings` is a single table across all
 * sources (RAG design spec §3.1) — same-source filtering happens here, in application
 * code, rather than via a `sqlite-vec` partition key, to avoid depending on a
 * less-battle-tested part of the extension's API for this tutorial (spec §4.2, §11).
 */
export function findNearestMatch(db: Database.Database, source: SourceName, queryVector: number[]): NearestMatch | null {
  const rows = db
    .prepare(
      `SELECT n.id AS notificationId, n.source AS source, n.formatted_message AS formattedMessage,
              n.posted_at AS postedAt, e.distance AS distance
       FROM agent_embeddings e
       JOIN agent_notifications n ON n.id = e.notification_id
       WHERE e.embedding MATCH ? AND k = ?
       ORDER BY e.distance`,
    )
    .all(JSON.stringify(queryVector), KNN_CANDIDATES) as CandidateRow[];

  const match = rows.find((row) => row.source === source);
  if (match === undefined) return null;

  return {
    notificationId: match.notificationId,
    distance: match.distance,
    formattedMessage: match.formattedMessage,
    postedAt: match.postedAt,
  };
}

/** Stores `vector` for `notificationId`, making it a future `findNearestMatch`
 *  candidate. Called once per posted notification (RAG design spec §3.1) — never for
 *  deduped/unchanged values. */
export function insertEmbedding(db: Database.Database, notificationId: number, vector: number[]): void {
  db.prepare(`INSERT INTO agent_embeddings (notification_id, embedding) VALUES (?, vec_f32(?))`).run(
    notificationId,
    JSON.stringify(vector),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/similarity.test.ts`
Expected: PASS, all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add src/rag/similarity.ts tests/similarity.test.ts
git commit -m "feat(rag): add same-source nearest-match KNN lookup and storage"
```

---

### Task 7: Extend `MessageFormatter` with similarity context

**Files:**
- Modify: `src/format/types.ts`
- Modify: `src/format/bedrock.ts`
- Modify: `tests/bedrock.test.ts`

`src/format/local.ts` needs **no change** — `format(source, rawValue) { ... }` (two params) already satisfies an interface whose third parameter is optional; TypeScript allows an implementation with fewer parameters than its declared type.

- [ ] **Step 1: Write the failing test**

Add to `tests/bedrock.test.ts`, inside the `describe('createBedrockFormatter', ...)` block, after the existing "prepends the family default inference-profile prefix" test:

```typescript

  it('includes the closest past reading in the prompt when one is provided', async () => {
    bedrock.on(ConverseCommand).resolves(textResponse('Similar to last time!'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await formatter.format('weather', '73F', {
      formattedMessage: 'Looks like 72F today!',
      postedAt: Date.parse('2026-08-01T00:00:00Z'),
    });

    const calls = bedrock.commandCalls(ConverseCommand);
    const userText = calls[0]?.args[0].input?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(userText).toContain('Looks like 72F today!');
    expect(userText).toContain('2026-08-01');
  });

  it('omits any past-reading line when nearestMatch is null or omitted', async () => {
    bedrock.on(ConverseCommand).resolves(textResponse('No history yet!'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await formatter.format('weather', '73F', null);

    const calls = bedrock.commandCalls(ConverseCommand);
    const userText = calls[0]?.args[0].input?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(userText).not.toContain('Closest past reading');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bedrock.test.ts -t "closest past reading"`
Expected: FAIL — `formatter.format` only accepts 2 arguments per its current type, and the prompt never contains the past-reading text.

- [ ] **Step 3: Add `SimilarPastResult` to `src/format/types.ts`**

Replace the full contents of `src/format/types.ts`:

```typescript
import type { SourceName } from '../db/schema.js';

export type { SourceName };

/** The minimal shape `format()` needs from a RAG nearest-match lookup (see
 *  `src/rag/similarity.ts`'s richer `NearestMatch`) — kept separate so `format/` doesn't
 *  import from `rag/`; a `NearestMatch` is structurally assignable here since it has
 *  every field `SimilarPastResult` needs and more. */
export interface SimilarPastResult {
  formattedMessage: string;
  postedAt: number;
}

/** Turns a raw fetched value into a friendly Discord message. `LocalTemplateFormatter`
 *  (this PR) and `BedrockFormatter` (PR2) implement the same interface, so the writer's
 *  hot path does not change between local and deployed (spec §2). `similarPast`, when
 *  provided, is the closest same-source past notification (RAG design spec §4.3) —
 *  `null`/omitted means no history exists yet or the RAG lookup failed and was isolated. */
export interface MessageFormatter {
  format(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): Promise<string>;
}
```

- [ ] **Step 4: Extend the prompt in `src/format/bedrock.ts`**

Modify `src/format/bedrock.ts:1-4` (imports) — add `SimilarPastResult` to the existing `./types.js` import:

```typescript
import { type BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { SourceName } from '../db/schema.js';
import { resolveFamily } from './families.js';
import type { MessageFormatter, SimilarPastResult } from './types.js';
```

Modify `src/format/bedrock.ts:34-41` (the system prompt and `buildUserPrompt`):

```typescript
const SYSTEM_PROMPT =
  'You write a single short, friendly Discord notification message announcing a new ' +
  'value for a tracked data source. Reply with the message text only — no quotes, no ' +
  'preamble, no markdown formatting. If a closest past reading is included below, you ' +
  'may naturally reference it if relevant, but you are not required to.';

function buildUserPrompt(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): string {
  const base = `Source: ${source}\nNew value: ${rawValue}`;
  if (similarPast === null || similarPast === undefined) return base;
  const date = new Date(similarPast.postedAt).toISOString().slice(0, 10);
  return `${base}\nClosest past reading (${date}): "${similarPast.formattedMessage}"`;
}
```

Modify `src/format/bedrock.ts` — the `attempt` function and the returned `format` method (currently around lines 90–126) to thread `similarPast` through:

```typescript
export function createBedrockFormatter(options: BedrockFormatterOptions): MessageFormatter {
  async function attempt(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): Promise<string> {
    const response = await options.client.send(
      new ConverseCommand({
        modelId: composedModelId(options.modelId),
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: buildUserPrompt(source, rawValue, similarPast) }] }],
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
    async format(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): Promise<string> {
      try {
        return await attempt(source, rawValue, similarPast);
      } catch (error: unknown) {
        if (isThrottlingOr5xx(error)) {
          await delay(RETRY_DELAY_MS);
          try {
            return await attempt(source, rawValue, similarPast);
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

Everything else in `src/format/bedrock.ts` (`composedModelId`, `delay`, `mapBedrockError`, `isThrottlingOr5xx`) is unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/bedrock.test.ts`
Expected: PASS, all cases (existing + 2 new).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. (`src/format/local.ts` needs no code change, confirmed by typecheck passing.)

- [ ] **Step 7: Commit**

```bash
git add src/format/types.ts src/format/bedrock.ts tests/bedrock.test.ts
git commit -m "feat(rag): thread closest-past-reading context into the Bedrock prompt"
```

---

### Task 8: Wire RAG into `runFetch`

**Files:**
- Modify: `src/agent/fetch.ts`
- Modify: `tests/fetch.test.ts`

This is the task where a query-embed/match failure must **not** abort the source's post (design spec §6) — get the nested try/catch right.

- [ ] **Step 1: Update existing `tests/fetch.test.ts` calls to pass an `embedder`**

`RunFetchParams` gains a required `embedder` field in Step 3 below, so every existing `runFetch({...})` call in `tests/fetch.test.ts` needs an `embedder: createLocalEmbedder()` entry. Add the import at the top of `tests/fetch.test.ts`:

```typescript
import { createLocalEmbedder } from '../src/embed/local.js';
```

Then add `embedder: createLocalEmbedder(),` to the params object in **every** `runFetch({...})` call in the file. As of this plan, that's these calls (identify by the `dbPath: ctx.dbPath,` or `dbPath: ctx.dbPath,` line that opens each params object — there are 7 call sites across 6 `it(...)` blocks, including both calls inside the "conditional write 412" test). Example for the first one (`'bootstraps on first run...'`):

```typescript
    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster,
      formatter: countingFormatter,
      embedder: createLocalEmbedder(),
      runId: 'r1',
      now: () => 1000,
    });
```

Apply the same `embedder: createLocalEmbedder(),` addition (right after `formatter:` in each object) to the other 6 call sites.

- [ ] **Step 2: Run the existing suite to confirm it now fails on the type, then add new RAG-specific tests**

Run: `npx vitest run tests/fetch.test.ts`
Expected: FAIL — TypeScript error, `RunFetchParams` doesn't have `embedder` yet (this is expected; Step 1 prepared the tests ahead of the interface change, the reverse of strict TDD ordering, because every existing call site needed updating together rather than one at a time). Confirm the failure is the type error, not something else, then continue.

Now append three new test cases at the end of the `describe('runFetch', ...)` block, right before the final closing `});`:

```typescript

  it('records nearest_match_id/nearest_match_distance pointing at a prior same-source notification', async () => {
    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster: fakeDiscordPoster(),
      formatter: createLocalTemplateFormatter(),
      embedder: createLocalEmbedder(),
      runId: 'r1',
      now: () => 1000,
    });
    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['75F'])],
      poster: fakeDiscordPoster(),
      formatter: createLocalTemplateFormatter(),
      embedder: createLocalEmbedder(),
      runId: 'r2',
      now: () => 2000,
    });

    const reopened = openDatabase(ctx.dbPath);
    const rows = reopened
      .prepare(`SELECT id, nearest_match_id, nearest_match_distance FROM agent_notifications ORDER BY id`)
      .all() as Array<{ id: number; nearest_match_id: number | null; nearest_match_distance: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.nearest_match_id).toBeNull(); // first-ever weather notification: no history to match
    expect(rows[0]?.nearest_match_distance).toBeNull();
    expect(rows[1]?.nearest_match_id).toBe(rows[0]?.id);
    expect(typeof rows[1]?.nearest_match_distance).toBe('number');
    reopened.close();
    ctx.cleanup();
  });

  it('does not match a different source\'s prior notification (same-source filtering)', async () => {
    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster: fakeDiscordPoster(),
      formatter: createLocalTemplateFormatter(),
      embedder: createLocalEmbedder(),
      runId: 'r1',
      now: () => 1000,
    });
    await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('crypto', ['67234.10'])],
      poster: fakeDiscordPoster(),
      formatter: createLocalTemplateFormatter(),
      embedder: createLocalEmbedder(),
      runId: 'r2',
      now: () => 2000,
    });

    const reopened = openDatabase(ctx.dbPath);
    const cryptoRow = reopened
      .prepare(`SELECT nearest_match_id FROM agent_notifications WHERE source = 'crypto'`)
      .get() as { nearest_match_id: number | null };
    expect(cryptoRow.nearest_match_id).toBeNull();
    reopened.close();
    ctx.cleanup();
  });

  it('embedding failure is isolated: notification still posts, error recorded, nearest_match stays null', async () => {
    const poster = fakeDiscordPoster();
    const throwingEmbedder = {
      async embed(): Promise<number[]> {
        throw new Error('Titan throttled');
      },
    };

    const result = await runFetch({
      dbPath: ctx.dbPath,
      store: ctx.store,
      storeKey: 'memory.db',
      sources: [fakeSourceFetcher('weather', ['72F'])],
      poster,
      formatter: createLocalTemplateFormatter(),
      embedder: throwingEmbedder,
      runId: 'r1',
      now: () => 1000,
    });

    expect(result.outcome).toBe('success');
    expect(poster.posted).toEqual(['Weather update: 72F']); // post still happens despite embed failure

    const reopened = openDatabase(ctx.dbPath);
    const run = reopened.prepare(`SELECT error FROM agent_runs WHERE run_id = 'r1'`).get() as { error: string };
    expect(run.error).toMatch(/Titan throttled/);

    const notification = reopened
      .prepare(`SELECT nearest_match_id FROM agent_notifications`)
      .get() as { nearest_match_id: number | null };
    expect(notification.nearest_match_id).toBeNull();
    reopened.close();
    ctx.cleanup();
  });
```

Also add the `createLocalTemplateFormatter` import is already present; confirm the top-of-file imports now include:

```typescript
import { createLocalEmbedder } from '../src/embed/local.js';
```

alongside the existing imports (already added in Step 1).

- [ ] **Step 3: Implement the RAG flow in `src/agent/fetch.ts`**

Modify `src/agent/fetch.ts:1-10` (imports):

```typescript
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { bootstrap } from '../db/bootstrap.js';
import { openDatabase } from '../db/open.js';
import type { Embedder } from '../embed/titan.js';
import type { DiscordPoster } from '../discord/poster.js';
import type { MessageFormatter } from '../format/types.js';
import { findNearestMatch, insertEmbedding } from '../rag/similarity.js';
import type { SourceFetcher } from '../sources/types.js';
import type { Store } from '../store/types.js';
import { finishRun, startRun } from './runLog.js';
```

Modify `src/agent/fetch.ts:12-21` (`RunFetchParams`) — add `embedder`:

```typescript
export interface RunFetchParams {
  dbPath: string;
  store: Store;
  storeKey: string;
  sources: SourceFetcher[];
  poster: DiscordPoster;
  formatter: MessageFormatter;
  embedder: Embedder;
  runId?: string;
  now?: () => number;
}
```

Modify the per-source loop body (`src/agent/fetch.ts`, currently lines 68–106, inside `for (const source of params.sources) { try { ... } catch ... }`). Replace the full `try` block's contents with:

```typescript
    try {
      const rawValue = await source.fetch();

      const existingRow = db
        .prepare(`SELECT last_value FROM agent_sources WHERE name = ?`)
        .get(source.name) as { last_value: string | null } | undefined;
      const lastValue = existingRow?.last_value ?? null;

      if (rawValue === lastValue) {
        continue; // dedup: no formatter call, no post, no notification row
      }

      // RAG query step: find the closest same-source past notification. Failure here is
      // isolated — it degrades to "no similarity context this run" (same as a source's
      // first-ever notification), it never blocks the post itself (spec §6).
      let match: Awaited<ReturnType<typeof findNearestMatch>> = null;
      try {
        const queryVector = await params.embedder.embed(rawValue);
        match = findNearestMatch(db, source.name, queryVector);
      } catch (embedError: unknown) {
        const message = embedError instanceof Error ? embedError.message : String(embedError);
        errors.push(`${source.name} (embedding query): ${message}`);
      }

      const formatted = await params.formatter.format(source.name, rawValue, match);
      await params.poster.post(formatted);

      const postedAt = now();
      // Insert into agent_sources first — agent_notifications has a FK on source, so a
      // notifications insert on a brand-new source would violate the constraint.
      db.prepare(
        `INSERT INTO agent_sources (name, last_value, last_fetched_at, last_posted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           last_value = excluded.last_value,
           last_fetched_at = excluded.last_fetched_at,
           last_posted_at = excluded.last_posted_at`,
      ).run(source.name, rawValue, postedAt, postedAt);

      const insertResult = db
        .prepare(
          `INSERT INTO agent_notifications
             (source, value, formatted_message, posted_at, nearest_match_id, nearest_match_distance)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(source.name, rawValue, formatted, postedAt, match?.notificationId ?? null, match?.distance ?? null);

      // RAG store step: embed what was actually posted and make it a future match
      // candidate. Failure here is isolated too — the notification has already
      // committed; only the corpus fails to grow by this one entry (spec §6).
      try {
        const storeVector = await params.embedder.embed(formatted);
        insertEmbedding(db, Number(insertResult.lastInsertRowid), storeVector);
      } catch (storeError: unknown) {
        const message = storeError instanceof Error ? storeError.message : String(storeError);
        errors.push(`${source.name} (embedding store): ${message}`);
      }

      notificationsSent++;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    }
```

The rest of `runFetch` (the outer function signature, `startRun`/`finishRun` calls, the conditional-publish step) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/fetch.test.ts`
Expected: PASS, all cases (existing 6 + 3 new).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/fetch.ts tests/fetch.test.ts
git commit -m "feat(rag): wire nearest-match lookup and embedding storage into runFetch"
```

---

### Task 9: `status` endpoint exposes `nearestMatch`

**Files:**
- Modify: `src/agent/status.ts`
- Modify: `tests/status.test.ts`

- [ ] **Step 1: Update existing test assertions**

`NotificationStatus` gains a required `nearestMatch` field, so every existing `toEqual([{ source: ..., value: ..., formattedMessage: ..., postedAt: ... }])` assertion in `tests/status.test.ts` needs `nearestMatch: null` added to each object. There are 3 such assertions (in `'downloads and returns sources + recentNotifications on first call'`, `'re-downloads and re-opens when the version changes'`, and `'clears cache state when store.get throws...'`) plus one more in `'clears cache state on HEAD-succeeds-GET-null...'`. For each, change e.g.:

```typescript
    expect(result.recentNotifications).toEqual([
      { source: 'weather', value: '72F', formattedMessage: 'Looks like 72F today!', postedAt: 1000 },
    ]);
```

to:

```typescript
    expect(result.recentNotifications).toEqual([
      { source: 'weather', value: '72F', formattedMessage: 'Looks like 72F today!', postedAt: 1000, nearestMatch: null },
    ]);
```

Apply this same `nearestMatch: null` addition to all 4 occurrences of this assertion shape in the file (the exact variable names differ — `result`, `second`, `recovered` — but the object shape being compared is the same in each).

- [ ] **Step 2: Add a new test for a populated `nearestMatch`**

Append inside the `describe('createStatusReader', ...)` block, before the closing `});`:

```typescript

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/status.test.ts`
Expected: FAIL — `nearestMatch` doesn't exist on the returned objects yet.

- [ ] **Step 4: Add `nearestMatch` to `src/agent/status.ts`**

Modify `src/agent/status.ts:13-24` (`NotificationStatus` and `StatusResult` are unchanged in shape except `NotificationStatus`):

```typescript
export interface SourceStatus {
  name: string;
  lastValue: string | null;
  lastFetchedAt: number | null;
  lastPostedAt: number | null;
}

export interface NotificationStatus {
  source: string;
  value: string;
  formattedMessage: string;
  postedAt: number;
  /** The closest same-source past notification at the time this one was posted (RAG
   *  design spec §7), or `null` if this was the source's first-ever notification, or the
   *  RAG lookup failed and was isolated (spec §6) — the two cases are indistinguishable
   *  here on purpose, since neither has a match to show. Populated once, at write time,
   *  by `runFetch`; this module never runs a vector query itself. */
  nearestMatch: {
    source: string;
    formattedMessage: string;
    postedAt: number;
    distance: number;
  } | null;
}

export interface StatusResult {
  snapshotVersion: string | null;
  sources: SourceStatus[];
  recentNotifications: NotificationStatus[];
}
```

Modify `queryStatus`'s notifications query and mapping (currently lines 52–79 in `src/agent/status.ts`):

```typescript
  // id DESC is a tie-breaker for notifications that share the same posted_at — without
  // it, the LIMIT picks an arbitrary subset and the endpoint output is not stable. The
  // LEFT JOIN pulls the matched notification's own source/message/postedAt so the status
  // endpoint is self-contained — no vector search happens here, only a second read of
  // already-open agent_notifications (RAG design spec §7).
  const notifications = db
    .prepare(
      `SELECT n.source, n.value, n.formatted_message, n.posted_at, n.nearest_match_distance,
              m.source AS matched_source, m.formatted_message AS matched_formatted_message,
              m.posted_at AS matched_posted_at
       FROM agent_notifications n
       LEFT JOIN agent_notifications m ON m.id = n.nearest_match_id
       ORDER BY n.posted_at DESC, n.id DESC LIMIT ?`,
    )
    .all(RECENT_NOTIFICATIONS_LIMIT) as Array<{
    source: string;
    value: string;
    formatted_message: string;
    posted_at: number;
    nearest_match_distance: number | null;
    matched_source: string | null;
    matched_formatted_message: string | null;
    matched_posted_at: number | null;
  }>;

  return {
    snapshotVersion: etag,
    sources: sources.map((row) => ({
      name: row.name,
      lastValue: row.last_value,
      lastFetchedAt: row.last_fetched_at,
      lastPostedAt: row.last_posted_at,
    })),
    recentNotifications: notifications.map((row) => ({
      source: row.source,
      value: row.value,
      formattedMessage: row.formatted_message,
      postedAt: row.posted_at,
      nearestMatch:
        row.matched_source === null
          ? null
          : {
              source: row.matched_source,
              formattedMessage: row.matched_formatted_message as string,
              postedAt: row.matched_posted_at as number,
              distance: row.nearest_match_distance as number,
            },
    })),
  };
```

Everything else in `src/agent/status.ts` (`RECENT_NOTIFICATIONS_LIMIT`, `ReaderState`, `StatusReader`, `createStatusReader`) is unchanged — the `sources` query above stays exactly as it is today too, only shown here for context.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/status.test.ts`
Expected: PASS, all cases (existing + 1 new).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent/status.ts tests/status.test.ts
git commit -m "feat(rag): expose nearestMatch on the status endpoint"
```

---

### Task 10: Wire the embedder into `handler.ts` and `localFetch.ts`

**Files:**
- Modify: `src/handler.ts`
- Modify: `src/localFetch.ts`

No new tests in this task — `tests/handler.test.ts`'s existing `op=fetch` tests already exercise this path end-to-end and will fail to compile/run if the wiring is wrong, since `runFetch` now requires `embedder`.

- [ ] **Step 1: Wire `createTitanEmbedder` into `src/handler.ts`**

Modify `src/handler.ts:1-11` (imports) — add the Titan embedder import:

```typescript
// src/handler.ts
import { timingSafeEqual } from 'node:crypto';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { runFetch } from './agent/fetch.js';
import { createStatusReader, type StatusReader } from './agent/status.js';
import { loadConfig } from './config.js';
import { createFetchDiscordPoster } from './discord/poster.js';
import { createTitanEmbedder } from './embed/titan.js';
import { createBedrockFormatter } from './format/bedrock.js';
import { createSourceFetcher } from './sources/index.js';
import type { SourceFetcher, SourceName } from './sources/types.js';
import { createS3Store } from './store/s3.js';
```

Modify `src/handler.ts` where `formatter` is constructed (in `runHandler`, after the token-gating block added in the earlier weather-location/fetch-trigger work) — add the embedder right after `formatter`:

```typescript
  const store = createS3Store({ client: s3Client, bucket: config.snapshotBucket });
  const formatter = createBedrockFormatter({
    client: bedrockClient,
    modelId: config.bedrockModelId,
    region: config.bedrockRegion,
    maxOutputTokens: config.bedrockMaxOutputTokens,
  });
  const embedder = createTitanEmbedder({ client: bedrockClient, region: config.bedrockRegion });
```

Modify the `runFetch({...})` call at the bottom of `runHandler` — add `embedder,`:

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

- [ ] **Step 2: Wire `createLocalEmbedder` into `src/localFetch.ts`**

Replace the full contents of `src/localFetch.ts`:

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
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — in particular, `tests/handler.test.ts`'s `op=fetch` tests (including the fetch-trigger-token ones added earlier) exercise `runHandler`'s real embedder wiring against the mocked `BedrockRuntimeClient`, which handles both `ConverseCommand` and `InvokeModelCommand` through the same mock client instance.

- [ ] **Step 4: Manually verify `local-fetch` still runs end-to-end**

Run: `set -a; . ./.env; set +a; npm run local-fetch` (requires `DISCORD_WEBHOOK_URL` in `.env`, per the README's Quick start)
Expected: Exits 0, prints a JSON result with `"outcome": "success"`, and (if weather/crypto changed since the last local run) posts to Discord. This confirms `createLocalEmbedder` satisfies `runFetch`'s RAG step with no AWS credentials involved, matching Phase 1's "no AWS" promise.

- [ ] **Step 5: Commit**

```bash
git add src/handler.ts src/localFetch.ts
git commit -m "feat(rag): wire Titan/local embedder into the Lambda handler and local-fetch"
```

---

### Task 11: IAM for the Titan embedding model

**Files:**
- Modify: `infra/stack.ts`

- [ ] **Step 1: Add the fixed Titan resource ARN**

Modify `infra/stack.ts`'s `bedrockPolicy` construction (currently around lines 100–105):

```typescript
    // ---- Bedrock IAM ----

    const bedrockPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
      resources: [
        ...buildBedrockResources(bedrockModelId, this.region),
        // Titan Text Embeddings V2 for RAG (RAG design spec §8) — fixed, unlike the chat
        // model: it isn't configurable, so it needs no family-resolution branch through
        // buildBedrockResources.
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    });
    agentFunction.addToRolePolicy(bedrockPolicy);
```

- [ ] **Step 2: Verify the stack still synthesizes**

Run: `npm run cdk -- synth SqliteS3AgentTutorial 2>&1 | tail -5` (requires `DISCORD_WEBHOOK_URL` set — `set -a; . ./.env.discord; set +a` first, per the README)
Expected: Synth succeeds (prints stack YAML/JSON to stdout or writes `cdk.out`), no errors about `buildBedrockResources` or the new ARN.

- [ ] **Step 3: Commit**

```bash
git add infra/stack.ts
git commit -m "feat(rag): grant IAM invoke permission for the Titan embedding model"
```

---

### Task 12: Documentation

**Files:**
- Create: `docs/08-rag-vector-search.md`
- Modify: `README.md`
- Modify: `docs/01-architecture.md`

- [ ] **Step 1: Mention RAG in the README's intro paragraph**

Modify `README.md`'s opening paragraph (currently line 3, right after the `# sqlite-s3-agent-tutorial` heading):

```markdown
A working example of the **SQLite-as-a-database-for-an-agent-on-AWS, rehydrated-by-S3**
pattern: a Discord bot that checks the weather and Bitcoin price once a day, asks an LLM
(Amazon Bedrock) to turn the raw value into a friendly message, posts it to a Discord
webhook, and remembers what it already posted — all state lives in a single SQLite file
in S3. No database server, no VPC. The same file also doubles as a vector database: each
posted message gets embedded (Titan Text Embeddings V2) and searched with `sqlite-vec`,
so the bot can mention the closest past result — see
[docs/08-rag-vector-search.md](docs/08-rag-vector-search.md).
```

- [ ] **Step 2: Write `docs/08-rag-vector-search.md`**

Create `docs/08-rag-vector-search.md`:

```markdown
# RAG: SQLite as a vector database too

The rest of this tutorial's docs show SQLite replacing a database *server* (see
[01-architecture.md](01-architecture.md)). This doc shows the same file replacing a
*vector database* too — no Pinecone, no pgvector, no separate service. The `sqlite-vec`
loadable extension turns a table in `memory.db` into a KNN index; Amazon Titan Text
Embeddings V2 turns text into the vectors that index stores.

## What actually happens, per source, per `fetch` run

1. A new value shows up (dedup already ruled out "unchanged from yesterday" before this
   point — see [03-schema.md](03-schema.md)).
2. The raw value gets embedded (Titan) and searched against `agent_embeddings` for the
   closest **same-source** past notification. First-ever notification for a source? No
   match — nothing to search yet.
3. If a match exists, its text and date go into the same Bedrock prompt that formats
   today's message — the model may naturally reference it ("looks like last Tuesday's
   reading!"), but isn't required to.
4. The message posts to Discord as usual.
5. The *formatted* message — not the raw value — gets embedded and stored, becoming a
   candidate for tomorrow's (or next week's) search.

Two Titan calls per posted notification: one to search with (step 2, embeds the raw
value, since the formatted message doesn't exist yet), one to store with (step 5, embeds
the formatted message, since that's the richer, more semantically meaningful text and by
this point it exists). Deduped/unchanged values never reach either call — same principle
as the LLM formatting call already skipping unchanged values (spec: `docs/03-schema.md`).

## Why one `agent_embeddings` table, not one per source

Sources are a closed vocabulary maintained in exactly one place — `SOURCE_NAMES` in
`src/db/schema.ts` (see [04-extending.md](04-extending.md)). A vector table per source
would mean editing a second place every time a source is added, breaking that invariant.
Instead, `agent_embeddings` is one table across every source, and same-source filtering
happens in application code (`src/rag/similarity.ts`'s `findNearestMatch`): a fixed KNN
scan of the 50 closest vectors *regardless of source*, then a filter down to the
requested source, then the closest survivor. Good enough for a workload that grows by at
most a couple of rows a day — not engineered for a corpus where the true nearest
same-source match might not be among the 50 closest across all sources combined.

## Why the query embeds the raw value but the stored embedding is the formatted message

This is the one asymmetry worth calling out. At search time (step 2 above), the
notification hasn't been formatted yet — there's nothing to embed *except* the raw
value. At store time (step 5), the formatted message exists, and it's the more
semantically rich text (Titan famously embeds "a sunny 72°F afternoon" more usefully than
it embeds the bare string "72F"). Both go through the same embedding model, into the same
256-dimension space, so a raw-value query against formatted-message-embedded history still
works — Titan doesn't require its inputs to share a style, just a language.

## Seeing it work

The `status` endpoint's `recentNotifications[]` includes a `nearestMatch` field per
notification — `null` if there was no history yet (or the embedding step failed and was
isolated, see below), otherwise the matched notification's own source/message/date and
the cosine distance between the two vectors. This is read straight off two plain columns
on `agent_notifications` (`nearest_match_id`, `nearest_match_distance`) — the reader never
runs a vector query itself, only the writer does.

## What happens when Titan is unavailable

Both embedding calls (search and store) are wrapped in the same per-source error
isolation `runFetch` already has for fetch/format/post failures. A Titan outage degrades
this feature to "no similarity mentioned today" — it never blocks the Discord post, and
it shows up in `agent_runs.error` like any other per-source failure (see
[03-schema.md](03-schema.md)'s explanation of why that column exists).

## Out of scope

- Cross-source similarity search (a "closest crypto price to today's weather" comparison
  isn't semantically meaningful for this tutorial's two sources).
- A configurable embedding model or dimension count (fixed at Titan v2 / 256 dims — the
  fixed value avoids a "how do I migrate the corpus" problem this tutorial doesn't need).
- Backfilling embeddings for notifications posted before this feature shipped — the
  corpus starts growing from the first `fetch` run after deploying this.
- A similarity threshold below which nothing gets mentioned — every match found is used,
  regardless of distance, to keep the demo mechanical and simple to test.
```

- [ ] **Step 3: Add the doc table row to `README.md`**

Modify `README.md`'s `## What's here` table — add a row after the `docs/07-budget-protection.md` row:

```markdown
| [docs/07-budget-protection.md](docs/07-budget-protection.md) | Setting up an AWS Budget alert, and what could actually drive cost up |
| [docs/08-rag-vector-search.md](docs/08-rag-vector-search.md) | SQLite as a vector database too: sqlite-vec + Titan embeddings |
```

- [ ] **Step 4: Note the Titan calls in `docs/01-architecture.md`**

Modify `docs/01-architecture.md`'s "LLM message formatting" paragraph (the one starting `**LLM message formatting.**`) — append one sentence at the end of that paragraph:

```markdown
**LLM message formatting.** Between the value fetch and the Discord post, the writer calls Amazon Bedrock (default `zai.glm-4.7-flash`) to turn the raw value into a friendly message. Dedup runs on the raw `value` *before* the LLM call (§3.1 step 3), so unchanged values never invoke Bedrock — the model is paid for only when there's actually something new to say. The model choice is overridable per environment via `bedrockModelId` (§11). The same `MessageFormatter` interface is implemented by `LocalTemplateFormatter` (Phase 1, no AWS) and `BedrockFormatter` (Phase 3, default), so the writer's hot path doesn't change between local and deployed. A second, smaller Bedrock round trip — Titan Text Embeddings V2, via `InvokeModel` rather than `Converse` — embeds each posted notification into a `sqlite-vec` table inside the same `memory.db` file, so the writer can mention the closest same-source past result in the prompt above; see [docs/08-rag-vector-search.md](08-rag-vector-search.md).
```

- [ ] **Step 5: Commit**

```bash
git add docs/08-rag-vector-search.md README.md docs/01-architecture.md
git commit -m "docs: explain the sqlite-vec + Titan RAG demo"
```

---

### Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full clean install and test run**

Run: `rm -rf node_modules && npm install && npm run typecheck && npm test`
Expected: All tests pass, typecheck clean, no leftover references to the pre-RAG `format()`/`runFetch()`/`NotificationStatus` shapes anywhere in `src/` or `tests/`.

- [ ] **Step 2: Confirm the Docker build still succeeds with the new dependency**

Run: `docker build -t sqlite-s3-agent-tutorial-rag-check .`
Expected: Build succeeds — in particular, the `npm ci` step in the build stage resolves `sqlite-vec-linux-arm64` (the platform this Dockerfile targets, per `Platform.LINUX_ARM64` in `infra/stack.ts`) with no missing-binary errors. This is the concrete check for the platform-compatibility risk called out in the design spec (§5) and this plan's header.

- [ ] **Step 3: Grep for stale references**

Run: `grep -rn "TBD\|TODO\|FIXME" src/ docs/08-rag-vector-search.md`
Expected: No output (or only pre-existing, unrelated matches outside files this plan touched).

- [ ] **Step 4: Review the diff**

Run: `git log --oneline -15` and `git diff main --stat` (or the equivalent for whatever base branch this work started from)
Expected: One commit per task above, touching exactly the files each task described — no stray edits.
