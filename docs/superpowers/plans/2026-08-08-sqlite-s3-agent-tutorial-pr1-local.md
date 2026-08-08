# SQLite S3 Agent Tutorial — PR1: Local (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the writer's local core — schema, bootstrap, dedup, an in-memory `DiscordPoster` and canned `SourceFetcher`, a `LocalTemplateFormatter` (no AWS) — and a CLI script (`npm run local-fetch`) that runs the writer end-to-end against `/tmp/memory.db`. This is Phase 1 of the design spec (`docs/superpowers/specs/2026-08-08-sqlite-s3-agent-tutorial-design.md`, §9).

**Architecture:** Every interface the writer depends on (`Store`, `SourceFetcher`, `DiscordPoster`, `MessageFormatter`) is defined now, in this PR, even though only their local/in-memory implementations exist yet. PR2 adds `S3Store` and `BedrockFormatter` behind the same interfaces — the writer's orchestration code (`src/agent/fetch.ts`) does not change between PRs. This mirrors `aws-cloud-agent`'s pattern of keeping AWS SDK types out of the orchestration layer entirely (see `aws-cloud-agent/src/writer/runLifecycle.ts`, which never imports `@aws-sdk/*`).

**Tech Stack:** TypeScript (ES2024/NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node 24, ESM, `better-sqlite3`, Vitest (`pool: 'forks'`, `fileParallelism: false` — matches `aws-cloud-agent/vitest.config.ts`, required because `better-sqlite3` file handles do not share safely across parallel test files), `tsx` for CLI scripts.

---

## File Structure

```
sqlite-s3-agent-tutorial/
├── src/
│   ├── config.ts                    # typed env config (Phase 1 subset: dbPath, discordWebhookUrl, sources)
│   ├── db/
│   │   ├── schema.ts                # DDL as constants (§5 of spec)
│   │   ├── bootstrap.ts             # idempotent CREATE TABLE IF NOT EXISTS
│   │   └── open.ts                  # better-sqlite3 factory
│   ├── store/
│   │   ├── types.ts                 # Store interface (shared by S3Store/LocalStore, PR2 adds S3Store)
│   │   └── local.ts                 # LocalStore — Store against a directory on disk
│   ├── sources/
│   │   ├── types.ts                 # SourceFetcher interface, SourceName, SOURCE_NAMES
│   │   ├── weather.ts                # real wttr.in-backed SourceFetcher (network, exercised only by CLI)
│   │   └── crypto.ts                 # real coingecko-backed SourceFetcher (network, exercised only by CLI)
│   ├── discord/
│   │   └── poster.ts                # DiscordPoster interface + real fetch-based impl
│   ├── format/
│   │   ├── types.ts                 # MessageFormatter interface
│   │   └── local.ts                 # LocalTemplateFormatter (deterministic, no AWS)
│   ├── agent/
│   │   ├── fetch.ts                 # the writer op — orchestration only, no AWS SDK imports
│   │   └── runLog.ts                # agent_runs insert/update helpers
│   └── localFetch.ts                # CLI entry: npm run local-fetch
├── tests/
│   ├── helpers/
│   │   ├── tempDb.ts                 # throwaway SQLite file path per test
│   │   ├── fakeSourceFetcher.ts       # canned-value SourceFetcher for tests
│   │   └── fakeDiscordPoster.ts       # in-memory recorder DiscordPoster for tests
│   ├── db.test.ts                    # bootstrap idempotency, schema shape, CHECK constraints
│   ├── format.test.ts                # LocalTemplateFormatter contract
│   └── fetch.test.ts                 # writer end-to-end against a real SQLite file + LocalStore
├── package.json
├── tsconfig.json
├── tsconfig.check.json
└── vitest.config.ts
```

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.check.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "sqlite-s3-agent-tutorial",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.check.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "local-fetch": "tsx src/localFetch.ts"
  },
  "dependencies": {
    "better-sqlite3": "^13.0.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.10.0",
    "tsx": "^4.23.5",
    "typescript": "^5.7.0",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `tsconfig.check.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts", "infra", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
*.db
*.db-journal
cdk.out/
.env
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, `package-lock.json` created, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.check.json vitest.config.ts .gitignore
git commit -m "chore: scaffold TypeScript/Vitest project"
```

---

## Task 2: DB schema constants

**Files:**
- Create: `src/db/schema.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db/schema.js'`

- [ ] **Step 3: Write `src/db/schema.ts`**

```typescript
/** Closed vocabulary for `agent_sources.name` (spec §5). Extend by editing this array
 *  and the CHECK constraint below — the tutorial is intentionally narrow. */
export const SOURCE_NAMES = ['weather', 'crypto'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

/** DDL for all three tables. Applied via `CREATE TABLE IF NOT EXISTS`, so re-running it
 *  against an already-bootstrapped database is a no-op (spec §4.1). */
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
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/db.test.ts
git commit -m "feat: add agent_sources/agent_notifications/agent_runs DDL"
```

---

## Task 3: Bootstrap and DB open

**Files:**
- Create: `src/db/bootstrap.ts`
- Create: `src/db/open.ts`
- Test: `tests/db.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/db.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db/bootstrap.js'`

- [ ] **Step 3: Write `src/db/open.ts`**

```typescript
import Database from 'better-sqlite3';

/**
 * Opens a file-backed SQLite database.
 *
 * DELETE journal mode, not WAL: the durable store is a single S3 object containing only
 * `memory.db` (spec §3.1 step 2). WAL keeps committed data in a sidecar `-wal` file, which
 * would make an S3 upload of `memory.db` alone silently omit the most recent writes.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  return db;
}
```

- [ ] **Step 4: Write `src/db/bootstrap.ts`**

```typescript
import type Database from 'better-sqlite3';
import { AGENT_DDL } from './schema.js';

/** Creates the three agent tables. Idempotent — safe to call on every writer invocation. */
export function bootstrap(db: Database.Database): void {
  db.exec(AGENT_DDL);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/db/bootstrap.ts src/db/open.ts tests/db.test.ts
git commit -m "feat: add idempotent bootstrap and DB open helper"
```

---

## Task 4: Store interface + LocalStore

**Files:**
- Create: `src/store/types.ts`
- Create: `src/store/local.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/store.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalStore } from '../src/store/local.js';

describe('LocalStore', () => {
  it('head and get return null when the key does not exist (bootstrap case)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    expect(await store.head('memory.db')).toBeNull();
    expect(await store.get('memory.db')).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  it('put with ifMatch: null succeeds on first write and returns an etag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    const result = await store.put('memory.db', Buffer.from('hello'), null);
    expect(result.etag).toBeTruthy();

    const got = await store.get('memory.db');
    expect(got?.body.toString()).toBe('hello');
    expect(got?.etag).toBe(result.etag);

    rmSync(dir, { recursive: true, force: true });
  });

  it('put with a matching ifMatch succeeds and changes the etag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    const first = await store.put('memory.db', Buffer.from('v1'), null);
    const second = await store.put('memory.db', Buffer.from('v2'), first.etag);

    expect(second.etag).not.toBe(first.etag);
    const got = await store.get('memory.db');
    expect(got?.body.toString()).toBe('v2');

    rmSync(dir, { recursive: true, force: true });
  });

  it('put with a stale ifMatch throws PreconditionFailedError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    await store.put('memory.db', Buffer.from('v1'), null);
    // Someone else writes in between.
    await store.put('memory.db', Buffer.from('v2'), (await store.head('memory.db'))?.etag ?? null);

    await expect(
      store.put('memory.db', Buffer.from('v3'), 'stale-etag'),
    ).rejects.toThrow(/PreconditionFailed/);

    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `Cannot find module '../src/store/local.js'`

- [ ] **Step 3: Write `src/store/types.ts`**

```typescript
/**
 * The abstraction the writer and reader use for the snapshot blob. `S3Store` (PR2) and
 * `LocalStore` implement the same interface so the agent's orchestration code never
 * branches on which backend is active.
 *
 * `ifMatch: string | null` — `null` means "this is a bootstrap put; there is no prior
 * version to match against." S3's HTTP `If-Match` semantics are translated by the S3
 * implementation and never leak into caller code (spec §4.2).
 */
export interface Store {
  /** Returns `{ etag }` for `key`, or `null` if it does not exist. */
  head(key: string): Promise<{ etag: string } | null>;
  /** Returns `{ etag, body }` for `key`, or `null` if it does not exist. */
  get(key: string): Promise<{ etag: string; body: Buffer } | null>;
  /**
   * Writes `body` to `key`. `ifMatch: null` performs a bootstrap put (no precondition on
   * the wire); a non-null value performs a conditional put.
   *
   * @throws {PreconditionFailedError} when `ifMatch` does not match the object's current
   *   etag (or the object does not exist and `ifMatch` was non-null).
   */
  put(key: string, body: Buffer, ifMatch: string | null): Promise<{ etag: string }>;
}

/** Thrown by `Store.put` on a conditional-write conflict. Do not retry (spec §4.2). */
export class PreconditionFailedError extends Error {
  constructor() {
    super(
      'Store conditional write failed: another writer committed first, or the object ' +
        'does not exist. Do not retry — a blind retry would re-fetch and re-post against ' +
        'a stale base.',
    );
    this.name = 'PreconditionFailedError';
  }
}
```

- [ ] **Step 4: Write `src/store/local.ts`**

```typescript
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PreconditionFailedError, type Store } from './types.js';

function etagOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** `Store` backed by a directory on disk. Mirrors S3's `If-Match` semantics locally so
 *  Phase 1 and Phase 2 exercise the same conditional-write contract (spec §9, Phase 2). */
export function createLocalStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });

  function pathFor(key: string): string {
    return join(dir, key);
  }

  return {
    async head(key: string) {
      const path = pathFor(key);
      if (!existsSync(path)) return null;
      return { etag: etagOf(readFileSync(path)) };
    },

    async get(key: string) {
      const path = pathFor(key);
      if (!existsSync(path)) return null;
      const body = readFileSync(path);
      return { etag: etagOf(body), body };
    },

    async put(key: string, body: Buffer, ifMatch: string | null) {
      const path = pathFor(key);
      const exists = existsSync(path);

      if (ifMatch === null) {
        if (exists) {
          throw new PreconditionFailedError();
        }
      } else {
        if (!exists) {
          throw new PreconditionFailedError();
        }
        const current = etagOf(readFileSync(path));
        if (current !== ifMatch) {
          throw new PreconditionFailedError();
        }
      }

      writeFileSync(path, body);
      return { etag: etagOf(body) };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/store/types.ts src/store/local.ts tests/store.test.ts
git commit -m "feat: add Store interface and LocalStore implementation"
```

---

## Task 5: SourceFetcher interface + test doubles

**Files:**
- Create: `src/sources/types.ts`
- Create: `tests/helpers/fakeSourceFetcher.ts`

- [ ] **Step 1: Write `src/sources/types.ts`**

No test needed — this is a pure type/interface file, exercised through Task 8's writer tests.

```typescript
import type { SourceName } from '../db/schema.js';

export type { SourceName };

/** Fetches one source's current raw value (e.g. `"72F"`, `"67234.10"`). Implementations
 *  hit an external HTTPS API (production) or return canned values (tests). */
export interface SourceFetcher {
  readonly name: SourceName;
  fetch(): Promise<string>;
}
```

- [ ] **Step 2: Write `tests/helpers/fakeSourceFetcher.ts`**

```typescript
import type { SourceFetcher, SourceName } from '../../src/sources/types.js';

/** Canned-value `SourceFetcher` for tests. Throws if `fetch()` is called more times than
 *  `values` has entries — a test asserting an exact call count catches over-fetching. */
export function fakeSourceFetcher(name: SourceName, values: string[]): SourceFetcher {
  let index = 0;
  return {
    name,
    async fetch() {
      if (index >= values.length) {
        throw new Error(`fakeSourceFetcher(${name}): no more canned values (called ${index + 1} times)`);
      }
      return values[index++] as string;
    },
  };
}

/** A `SourceFetcher` whose `fetch()` always throws, for partial-failure tests. */
export function throwingSourceFetcher(name: SourceName, message: string): SourceFetcher {
  return {
    name,
    async fetch() {
      throw new Error(message);
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/sources/types.ts tests/helpers/fakeSourceFetcher.ts
git commit -m "feat: add SourceFetcher interface and test double"
```

---

## Task 6: DiscordPoster interface + implementations

**Files:**
- Create: `src/discord/poster.ts`
- Create: `tests/helpers/fakeDiscordPoster.ts`
- Test: `tests/discord.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/discord.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createFetchDiscordPoster, DiscordPostError } from '../src/discord/poster.js';

describe('createFetchDiscordPoster', () => {
  it('posts the message as JSON content to the webhook URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return new Response(null, { status: 204 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await poster.post('hello world');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://discord.example/webhook');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ content: 'hello world' });
  });

  it('throws DiscordPostError on a 4xx response, no retry', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response('bad request', { status: 400 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await expect(poster.post('hello')).rejects.toThrow(DiscordPostError);
    expect(callCount).toBe(1);
  });

  it('retries once on a 5xx response, then throws if still failing', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response('server error', { status: 503 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await expect(poster.post('hello')).rejects.toThrow(DiscordPostError);
    expect(callCount).toBe(2);
  });

  it('succeeds if the retry after a 5xx returns 2xx', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(null, { status: callCount === 1 ? 503 : 204 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await expect(poster.post('hello')).resolves.toBeUndefined();
    expect(callCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/discord.test.ts`
Expected: FAIL — `Cannot find module '../src/discord/poster.js'`

- [ ] **Step 3: Write `src/discord/poster.ts`**

```typescript
/** Thrown by `DiscordPoster.post` on a non-2xx response after any retry has been exhausted. */
export class DiscordPostError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Discord webhook responded ${status}: ${body}`);
    this.name = 'DiscordPostError';
    this.status = status;
  }
}

/** Posts a formatted message to a Discord webhook. */
export interface DiscordPoster {
  post(message: string): Promise<void>;
}

const RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real `DiscordPoster`, backed by `fetch`.
 *
 * 4xx: no retry (spec §6) — the request is malformed or the webhook is invalid, and a
 * retry cannot fix that. 5xx: one retry with a fixed ~250ms backoff, then give up — the
 * writer skips this source's notification for the run and the next run tries again.
 */
export function createFetchDiscordPoster(
  webhookUrl: string,
  fetchImpl: typeof fetch = fetch,
): DiscordPoster {
  async function attempt(message: string): Promise<Response> {
    return fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  }

  return {
    async post(message: string): Promise<void> {
      let response = await attempt(message);

      if (!response.ok && response.status >= 500) {
        await delay(RETRY_DELAY_MS);
        response = await attempt(message);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new DiscordPostError(response.status, body);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/discord.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write `tests/helpers/fakeDiscordPoster.ts`**

```typescript
import type { DiscordPoster } from '../../src/discord/poster.js';

export interface RecordingDiscordPoster extends DiscordPoster {
  readonly posted: string[];
}

/** In-memory `DiscordPoster` for tests — records every posted message instead of making
 *  a network call (spec §7.1). */
export function fakeDiscordPoster(): RecordingDiscordPoster {
  const posted: string[] = [];
  return {
    posted,
    async post(message: string) {
      posted.push(message);
    },
  };
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/discord/poster.ts tests/discord.test.ts tests/helpers/fakeDiscordPoster.ts
git commit -m "feat: add DiscordPoster with 5xx retry and in-memory test double"
```

---

## Task 7: MessageFormatter interface + LocalTemplateFormatter

**Files:**
- Create: `src/format/types.ts`
- Create: `src/format/local.ts`
- Test: `tests/format.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/format.test.ts
import { describe, expect, it } from 'vitest';
import { createLocalTemplateFormatter } from '../src/format/local.js';

describe('LocalTemplateFormatter', () => {
  it('formats a weather value deterministically', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format('weather', '72F');
    expect(message).toBe('Weather update: 72F');
  });

  it('formats a crypto value deterministically', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format('crypto', '67234.10');
    expect(message).toBe('Crypto update: 67234.10');
  });

  it('produces the same output for the same input across calls', async () => {
    const formatter = createLocalTemplateFormatter();
    const first = await formatter.format('weather', '72F');
    const second = await formatter.format('weather', '72F');
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/format.test.ts`
Expected: FAIL — `Cannot find module '../src/format/local.js'`

- [ ] **Step 3: Write `src/format/types.ts`**

```typescript
import type { SourceName } from '../db/schema.js';

/** Turns a raw fetched value into a friendly Discord message. `LocalTemplateFormatter`
 *  (this PR) and `BedrockFormatter` (PR2) implement the same interface, so the writer's
 *  hot path does not change between local and deployed (spec §2). */
export interface MessageFormatter {
  format(source: SourceName, rawValue: string): Promise<string>;
}
```

- [ ] **Step 4: Write `src/format/local.ts`**

```typescript
import type { MessageFormatter } from './types.js';

const LABELS = { weather: 'Weather update', crypto: 'Crypto update' } as const;

/** Deterministic, no-AWS `MessageFormatter` for Phase 1 (spec §9). Never used in the
 *  deployed Lambda — `BedrockFormatter` (PR2) is the default there. */
export function createLocalTemplateFormatter(): MessageFormatter {
  return {
    async format(source, rawValue) {
      return `${LABELS[source]}: ${rawValue}`;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/format.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/format/types.ts src/format/local.ts tests/format.test.ts
git commit -m "feat: add MessageFormatter interface and LocalTemplateFormatter"
```

---

## Task 8: Run log helpers

**Files:**
- Create: `src/agent/runLog.ts`
- Test: `tests/runLog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/runLog.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';
import { finishRun, startRun } from '../src/agent/runLog.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runlog-test-'));
  const db = openDatabase(join(dir, 'memory.db'));
  bootstrap(db);
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('startRun / finishRun', () => {
  it('inserts a run row with no ended_at or outcome', () => {
    const { db, cleanup } = freshDb();

    startRun(db, { runId: 'r1', op: 'fetch', snapshotVersionIn: 'none', startedAt: 1000 });

    const row = db.prepare(`SELECT * FROM agent_runs WHERE run_id = 'r1'`).get() as Record<string, unknown>;
    expect(row.op).toBe('fetch');
    expect(row.snapshot_version_in).toBe('none');
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBeNull();
    expect(row.outcome).toBeNull();

    db.close();
    cleanup();
  });

  it('finishRun updates the same row with ended_at, outcome, and counts', () => {
    const { db, cleanup } = freshDb();

    startRun(db, { runId: 'r1', op: 'fetch', snapshotVersionIn: 'none', startedAt: 1000 });
    finishRun(db, {
      runId: 'r1',
      endedAt: 2000,
      outcome: 'success',
      sourcesChecked: 2,
      notificationsSent: 1,
      error: null,
    });

    const row = db.prepare(`SELECT * FROM agent_runs WHERE run_id = 'r1'`).get() as Record<string, unknown>;
    expect(row.ended_at).toBe(2000);
    expect(row.outcome).toBe('success');
    expect(row.sources_checked).toBe(2);
    expect(row.notifications_sent).toBe(1);
    expect(row.error).toBeNull();

    db.close();
    cleanup();
  });

  it('finishRun records a non-null error string when a source failed', () => {
    const { db, cleanup } = freshDb();

    startRun(db, { runId: 'r1', op: 'fetch', snapshotVersionIn: 'none', startedAt: 1000 });
    finishRun(db, {
      runId: 'r1',
      endedAt: 2000,
      outcome: 'success',
      sourcesChecked: 2,
      notificationsSent: 1,
      error: 'weather: fetch timeout',
    });

    const row = db.prepare(`SELECT error FROM agent_runs WHERE run_id = 'r1'`).get() as { error: string };
    expect(row.error).toBe('weather: fetch timeout');

    db.close();
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runLog.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/runLog.js'`

- [ ] **Step 3: Write `src/agent/runLog.ts`**

```typescript
import type Database from 'better-sqlite3';

export interface StartRunParams {
  runId: string;
  op: 'fetch' | 'status';
  snapshotVersionIn: string;
  startedAt: number;
}

export interface FinishRunParams {
  runId: string;
  endedAt: number;
  outcome: 'success' | 'error';
  sourcesChecked: number;
  notificationsSent: number;
  /** Per-source failures joined with `; ` (spec §6), or `null` when nothing failed. */
  error: string | null;
}

/** Inserts the `agent_runs` row at the start of a run (spec §3.1 step 4). */
export function startRun(db: Database.Database, params: StartRunParams): void {
  db.prepare(
    `INSERT INTO agent_runs (run_id, op, snapshot_version_in, started_at)
     VALUES (@runId, @op, @snapshotVersionIn, @startedAt)`,
  ).run(params);
}

/** Updates the `agent_runs` row at the end of a run (spec §3.1 step 6). A row inserted by
 *  `startRun` and never finished (crash mid-run) stays `ended_at IS NULL` — that is itself
 *  a signal, not a defaulted-away failure (spec §5). */
export function finishRun(db: Database.Database, params: FinishRunParams): void {
  db.prepare(
    `UPDATE agent_runs
     SET ended_at = @endedAt, outcome = @outcome, sources_checked = @sourcesChecked,
         notifications_sent = @notificationsSent, error = @error
     WHERE run_id = @runId`,
  ).run(params);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runLog.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/runLog.ts tests/runLog.test.ts
git commit -m "feat: add agent_runs start/finish helpers"
```

---

## Task 9: The writer (`fetch` op)

**Files:**
- Create: `src/agent/fetch.ts`
- Test: `tests/fetch.test.ts`

This is the core orchestration and the spec's trap guards (§7.2) live here.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/fetch.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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
    await ctx.store.put('memory.db', require('node:fs').readFileSync(ctx.dbPath), null);

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
    await ctx.store.put('memory.db', require('node:fs').readFileSync(ctx.dbPath), null);

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
    ctx.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fetch.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/fetch.js'`

- [ ] **Step 3: Write `src/agent/fetch.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { bootstrap } from '../db/bootstrap.js';
import { openDatabase } from '../db/open.js';
import type { DiscordPoster } from '../discord/poster.js';
import type { MessageFormatter } from '../format/types.js';
import type { SourceFetcher } from '../sources/types.js';
import type { Store } from '../store/types.js';
import { finishRun, startRun } from './runLog.js';

export interface RunFetchParams {
  dbPath: string;
  store: Store;
  storeKey: string;
  sources: SourceFetcher[];
  poster: DiscordPoster;
  formatter: MessageFormatter;
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
 * The writer op (spec §3.1). Hydrates from the store, runs bootstrap, checks each
 * configured source for a new value, formats and posts on change, records the run, and
 * publishes the updated snapshot back to the store with a conditional write.
 *
 * Per-source failures (fetch, formatter, or Discord post) are caught individually and
 * folded into `agent_runs.error`; the run still completes and outcome stays `'success'`
 * (spec §6). Only a `PreconditionFailedError` from the final publish propagates — that is
 * an abort, not a per-source failure (spec §4.2).
 */
export async function runFetch(params: RunFetchParams): Promise<RunFetchResult> {
  const runId = params.runId ?? randomUUID();
  const now = params.now ?? (() => Date.now());

  // Step 1: hydrate.
  const existing = await params.store.get(params.storeKey);
  if (existing !== null) {
    require('node:fs').writeFileSync(params.dbPath, existing.body);
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
  let notificationsSent = 0;

  // Step 5: per-source loop.
  for (const source of params.sources) {
    try {
      const rawValue = await source.fetch();

      const existingRow = db
        .prepare(`SELECT last_value FROM agent_sources WHERE name = ?`)
        .get(source.name) as { last_value: string | null } | undefined;
      const lastValue = existingRow?.last_value ?? null;

      if (rawValue === lastValue) {
        continue; // dedup: no formatter call, no post, no notification row
      }

      const formatted = await params.formatter.format(source.name, rawValue);
      await params.poster.post(formatted);

      const postedAt = now();
      db.prepare(
        `INSERT INTO agent_notifications (source, value, formatted_message, posted_at)
         VALUES (?, ?, ?, ?)`,
      ).run(source.name, rawValue, formatted, postedAt);

      db.prepare(
        `INSERT INTO agent_sources (name, last_value, last_fetched_at, last_posted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           last_value = excluded.last_value,
           last_fetched_at = excluded.last_fetched_at,
           last_posted_at = excluded.last_posted_at`,
      ).run(source.name, rawValue, postedAt, postedAt);

      notificationsSent++;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    }
  }

  // Step 6: finish the run record.
  const errorText = errors.length > 0 ? errors.join('; ') : null;
  finishRun(db, {
    runId,
    endedAt: now(),
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent,
    error: errorText,
  });

  db.close();

  // Step 7: conditional publish. A PreconditionFailedError here propagates — abort loudly,
  // do not retry (spec §4.2).
  const body = readFileSync(params.dbPath);
  await params.store.put(params.storeKey, body, priorEtag);

  return {
    outcome: 'success',
    sourcesChecked: params.sources.length,
    notificationsSent,
    error: errorText,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fetch.test.ts`
Expected: PASS (7 tests)

If the 412 test fails because `db.close()` already ran and the publish rejects after the
run row was written — that is correct per spec §6 ("S3 conditional write 412 ... Update
the in-progress agent_runs row with outcome = 'error'"). Adjust `runFetch` if needed so
the row is updated to `outcome: 'error'` before the `PreconditionFailedError` propagates:
wrap the final `put` in a try/catch that calls `finishRun` again with `outcome: 'error'`
and the failure appended to `error`, then rethrows. Re-run the test after adjusting.

- [ ] **Step 5: Fix the 412 abort path**

Replace the "Step 7: conditional publish" block in `src/agent/fetch.ts` with:

```typescript
  // Step 7: conditional publish. A PreconditionFailedError here is an abort, not a
  // per-source failure (spec §4.2) — the run row is updated to outcome: 'error' before
  // the error propagates, so the abort is visible in agent_runs even though the snapshot
  // holding that row was never uploaded.
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
      notificationsSent,
      error: errorText === null ? message : `${errorText}; ${message}`,
    });
    dbForFailure.close();
    throw error;
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/fetch.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors. If `formatter`/`store` structural types in the test file raise
`exactOptionalPropertyTypes` complaints, adjust the test's inline object types to match
`MessageFormatter`/`Store` exactly rather than loosening the interfaces.

- [ ] **Step 8: Commit**

```bash
git add src/agent/fetch.ts tests/fetch.test.ts
git commit -m "feat: implement writer (fetch) op with dedup and partial-failure handling"
```

---

## Task 10: Real SourceFetcher implementations (weather, crypto)

**Files:**
- Create: `src/sources/weather.ts`
- Create: `src/sources/crypto.ts`
- Create: `src/sources/index.ts`

No unit test — these hit real network endpoints (`wttr.in`, `coingecko`) and are
deliberately excluded from the mocked test boundary per spec §7.1 ("External value API |
Yes | A `SourceFetcher` interface... production = real `fetch`"). They are exercised by
the CLI in Task 11, not by `npm test`.

- [ ] **Step 1: Write `src/sources/weather.ts`**

```typescript
import type { SourceFetcher } from './types.js';

/** Fetches the current temperature for a fixed location from wttr.in's plain-text format.
 *  Key-free public endpoint, chosen for the tutorial demo (spec §11). */
export function createWeatherFetcher(location = 'NYC'): SourceFetcher {
  return {
    name: 'weather',
    async fetch() {
      const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=%t`);
      if (!response.ok) {
        throw new Error(`wttr.in responded ${response.status}`);
      }
      const text = await response.text();
      return text.trim();
    },
  };
}
```

- [ ] **Step 2: Write `src/sources/crypto.ts`**

```typescript
import type { SourceFetcher } from './types.js';

/** Fetches the current USD price of Bitcoin from CoinGecko's simple price endpoint.
 *  Key-free public endpoint, chosen for the tutorial demo (spec §11). */
export function createCryptoFetcher(): SourceFetcher {
  return {
    name: 'crypto',
    async fetch() {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      );
      if (!response.ok) {
        throw new Error(`coingecko responded ${response.status}`);
      }
      const json = (await response.json()) as { bitcoin?: { usd?: number } };
      const price = json.bitcoin?.usd;
      if (price === undefined) {
        throw new Error('coingecko response missing bitcoin.usd');
      }
      return String(price);
    },
  };
}
```

- [ ] **Step 3: Write `src/sources/index.ts`**

```typescript
import type { SourceName } from '../db/schema.js';
import { createCryptoFetcher } from './crypto.js';
import type { SourceFetcher } from './types.js';
import { createWeatherFetcher } from './weather.js';

/** Registry: source name -> real SourceFetcher. Extend by adding a case here and to
 *  `SOURCE_NAMES`/the schema CHECK constraint (spec §5, §11: "readers extend it by
 *  editing one CHECK constraint and one fetch function"). */
export function createSourceFetcher(name: SourceName): SourceFetcher {
  switch (name) {
    case 'weather':
      return createWeatherFetcher();
    case 'crypto':
      return createCryptoFetcher();
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/sources/weather.ts src/sources/crypto.ts src/sources/index.ts
git commit -m "feat: add real weather/crypto SourceFetcher implementations"
```

---

## Task 11: Config module (Phase 1 subset)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws when discordWebhookUrl is missing', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_WEBHOOK_URL/);
  });

  it('applies defaults for dbPath and sources', () => {
    const config = loadConfig({ DISCORD_WEBHOOK_URL: 'https://discord.example/webhook' });
    expect(config.dbPath).toBe('/tmp/memory.db');
    expect(config.sources).toEqual(['weather', 'crypto']);
    expect(config.discordWebhookUrl).toBe('https://discord.example/webhook');
  });

  it('parses a custom SOURCES env var', () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SOURCES: '["weather"]',
    });
    expect(config.sources).toEqual(['weather']);
  });

  it('rejects a source outside the closed vocabulary', () => {
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        SOURCES: '["wether"]',
      }),
    ).toThrow(/wether/);
  });

  it('rejects malformed SOURCES JSON', () => {
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        SOURCES: 'not json',
      }),
    ).toThrow(/SOURCES/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: Write `src/config.ts`**

```typescript
import { SOURCE_NAMES, type SourceName } from './db/schema.js';

/**
 * Phase 1 subset of the config surface (spec §11). PR2 adds `region`, `snapshotBucket`,
 * `snapshotKey`, and the `bedrock*` fields; this module is the single place any of them
 * will be read from — no other module reads `process.env`.
 */
export interface AgentConfig {
  readonly dbPath: string;
  readonly discordWebhookUrl: string;
  readonly sources: readonly SourceName[];
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function str(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function sources(env: Env): readonly SourceName[] {
  const raw = env.SOURCES;
  if (raw === undefined || raw.trim() === '') {
    return ['weather', 'crypto'];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Environment variable SOURCES must be a JSON array, got: ${raw}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Environment variable SOURCES must be a JSON array, got: ${raw}`);
  }

  for (const entry of parsed) {
    if (typeof entry !== 'string' || !(SOURCE_NAMES as readonly string[]).includes(entry)) {
      throw new Error(
        `Environment variable SOURCES contains an unknown source "${String(entry)}". ` +
          `Known sources: ${SOURCE_NAMES.join(', ')}.`,
      );
    }
  }

  return parsed as SourceName[];
}

export function loadConfig(env: Env = process.env): AgentConfig {
  return Object.freeze({
    dbPath: str(env, 'DB_PATH', '/tmp/memory.db'),
    discordWebhookUrl: required(env, 'DISCORD_WEBHOOK_URL'),
    sources: sources(env),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add typed config module (Phase 1 subset)"
```

---

## Task 12: CLI entry point (`npm run local-fetch`)

**Files:**
- Create: `src/localFetch.ts`

No unit test — this is a thin CLI wrapper exercised manually per the phase verification
step (spec §9: "Run the script; assert the DB has the right rows").

- [ ] **Step 1: Write `src/localFetch.ts`**

```typescript
import { loadConfig } from './config.js';
import { runFetch } from './agent/fetch.js';
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
    sources: config.sources.map((name) => createSourceFetcher(name)),
    poster: createFetchDiscordPoster(config.discordWebhookUrl),
    formatter: createLocalTemplateFormatter(),
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 3: Manual verification**

Run:
```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/REPLACE_ME" \
DB_PATH=/tmp/memory-manual-test.db \
SOURCES='["weather"]' \
npm run local-fetch
```
Expected: JSON output with `outcome: "success"`, `notificationsSent: 1` (or `0` on a
second run against the same value — dedup working). Inspect the DB:
`sqlite3 /tmp/memory-manual-test.db "SELECT * FROM agent_sources;"` shows a `weather` row.

If no real Discord webhook is available, expect a `DiscordPostError` — that confirms the
network path is being exercised; substitute a syntactically valid but fake webhook URL
and confirm the process still completes the fetch/format/dedup logic before failing at
the post step.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all tests pass (schema, bootstrap, store, discord, format, runLog, fetch, config)

- [ ] **Step 5: Commit**

```bash
git add src/localFetch.ts
git commit -m "feat: add npm run local-fetch CLI entry point"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §3.1 steps 1-7 (bootstrap branch, dedup, LLM/formatter call, Discord
  post, run log, conditional publish) are all covered by Task 9. §4.1 bootstrap and §4.2
  conditional write are covered by Task 4 (LocalStore) and exercised end-to-end in Task 9.
  §5 schema is Task 2. §6 error handling (per-source failures, 412 abort) is Task 9 Steps
  1-6. §7.2 trap guards map 1:1 to Task 9's test cases. §11 config (Phase 1 subset) is
  Task 11. S3-specific config fields, `BedrockFormatter`, `S3Store`, Lambda deploy, and the
  `status` reader op are explicitly out of scope for this PR — they are PR2 and PR3.
- **Type consistency:** `SourceName` is defined once in `src/db/schema.ts` and re-exported
  from `src/sources/types.ts`; every other file imports it from one of those two places,
  never redeclares it. `MessageFormatter.format(source, rawValue)` and
  `SourceFetcher.fetch()` signatures are consistent from Task 5 through Task 12.
