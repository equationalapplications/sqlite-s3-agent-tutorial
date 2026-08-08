# SQLite S3 Agent Tutorial — PR3: Reader + Run Logs + Docs (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on:** PR1 and PR2 must be merged first. This plan assumes `src/agent/fetch.ts`,
`src/store/{types,local,s3}.ts`, `src/format/{types,local,bedrock,families}.ts`,
`src/db/{schema,bootstrap,open}.ts`, `src/handler.ts` (with `status` stubbed at 501), and
`infra/stack.ts` all exist and pass their tests.

**Goal:** Implement the `status` reader op with the version-cached hydration protocol
(spec §4.3), wire it into `src/handler.ts`, extend `scripts/smoke.sh` to exercise both
ops end-to-end, and write the tutorial's narrative docs (spec §10). This is Phase 4 of the
design spec (§9) plus the documentation deliverable that makes this a *tutorial* rather
than just working code.

**Architecture:** The reader keeps a module-scope cache — the last hydrated ETag and an
open read-only `better-sqlite3` handle — so a warm Lambda container costs a `HEAD` and a
query on an unchanged snapshot, downloading and reopening only when the version changes
(spec §4.3). This mirrors `aws-cloud-agent/src/reader/hydrationCache.ts`'s pattern:
close-and-reopen on every download, never reuse an open handle across a file swap, because
`better-sqlite3`'s page cache would silently describe a file that no longer exists.

**Tech Stack:** No new dependencies — reuses `better-sqlite3`, the `Store` interface, and
the existing test tooling from PR1/PR2.

---

## File Structure (additions to PR1 + PR2)

```
sqlite-s3-agent-tutorial/
├── README.md
├── docs/
│   ├── 01-architecture.md
│   ├── 02-rehydration.md
│   ├── 03-schema.md
│   ├── 04-extending.md
│   └── 05-from-tutorial-to-prod.md
├── src/
│   ├── db/
│   │   └── open.ts                  # MODIFY: add readonly option
│   ├── agent/
│   │   └── status.ts                # the reader op — version-cached hydration + query
│   └── handler.ts                   # MODIFY: wire status op, replace 501 stub
├── scripts/
│   └── smoke.sh                     # extended to query status after fetch
└── tests/
    ├── status.test.ts
    └── handler.test.ts              # MODIFY: replace the 501 stub test
```

---

## Task 1: Read-only DB open

**Files:**
- Modify: `src/db/open.ts`
- Test: `tests/db.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/db.test.ts`:

```typescript
import { openReadOnlyDatabase } from '../src/db/open.js';

describe('openReadOnlyDatabase', () => {
  it('opens an existing file without allowing writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const path = join(dir, 'memory.db');

    const writable = openDatabase(path);
    bootstrap(writable);
    writable.close();

    const readOnly = openReadOnlyDatabase(path);
    expect(() =>
      readOnly.prepare(`INSERT INTO agent_sources (name) VALUES ('weather')`).run(),
    ).toThrow(/readonly/i);

    readOnly.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — `openReadOnlyDatabase is not a function`

- [ ] **Step 3: Modify `src/db/open.ts`**

Append to the file:

```typescript
/**
 * Opens an existing SQLite file read-only. Used by the reader (spec §3.2): the reader's
 * IAM grant is GetObject-only (spec §2), so a read-only DB handle matches that intent even
 * though `better-sqlite3` itself has no knowledge of the S3 permission model.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/open.ts tests/db.test.ts
git commit -m "feat: add read-only DB open for the reader"
```

---

## Task 2: The reader (`status` op)

**Files:**
- Create: `src/agent/status.ts`
- Test: `tests/status.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/status.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';
import { createLocalStore } from '../src/store/local.js';
import { createStatusReader } from '../src/agent/status.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-status-test-'));
  const dbPath = join(dir, 'memory.db');
  const store = createLocalStore(join(dir, 'store'));
  return { dir, dbPath, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

  it('returns the empty-state JSON when no snapshot exists yet, without opening a handle', async () => {
    const reader = createStatusReader(ctx.dbPath);
    const result = await reader.getStatus(ctx.store, 'memory.db');

    expect(result).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });
    ctx.cleanup();
  });

  it('downloads and returns sources + recentNotifications on first call', async () => {
    await seedSnapshot(ctx.dbPath, ctx.store);
    writeFileSync(ctx.dbPath, ''); // simulate cold start: local file absent/stale

    const reader = createStatusReader(join(ctx.dir, 'reader-copy.db'));
    const result = await reader.getStatus(ctx.store, 'memory.db');

    expect(result.snapshotVersion).not.toBeNull();
    expect(result.sources).toEqual([
      { name: 'weather', lastValue: '72F', lastFetchedAt: 1000, lastPostedAt: 1000 },
    ]);
    expect(result.recentNotifications).toEqual([
      { source: 'weather', value: '72F', formattedMessage: 'Looks like 72F today!', postedAt: 1000 },
    ]);
    ctx.cleanup();
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
    ctx.cleanup();
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
    ctx.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/status.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/status.js'`

- [ ] **Step 3: Write `src/agent/status.ts`**

```typescript
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openReadOnlyDatabase } from '../db/open.js';
import type { Store } from '../store/types.js';

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
}

export interface StatusResult {
  snapshotVersion: string | null;
  sources: SourceStatus[];
  recentNotifications: NotificationStatus[];
}

/** Rows returned per `status` call, across all sources (spec §3.2 step 4). Not
 *  configurable — the reader is a diagnostic JSON endpoint, not a paginated API (spec §2). */
const RECENT_NOTIFICATIONS_LIMIT = 10;

interface ReaderState {
  cachedEtag: string | null;
  db: Database.Database | undefined;
}

export interface StatusReader {
  getStatus(store: Store, storeKey: string): Promise<StatusResult>;
}

function queryStatus(db: Database.Database, etag: string): StatusResult {
  const sources = db
    .prepare(`SELECT name, last_value, last_fetched_at, last_posted_at FROM agent_sources`)
    .all() as Array<{ name: string; last_value: string | null; last_fetched_at: number | null; last_posted_at: number | null }>;

  const notifications = db
    .prepare(
      `SELECT source, value, formatted_message, posted_at FROM agent_notifications
       ORDER BY posted_at DESC LIMIT ?`,
    )
    .all(RECENT_NOTIFICATIONS_LIMIT) as Array<{
    source: string;
    value: string;
    formatted_message: string;
    posted_at: number;
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
    })),
  };
}

/**
 * Creates a reader instance holding module-scope hydration state (spec §4.3): the last
 * hydrated ETag and an open read-only handle. Call `getStatus` on every invocation; the
 * instance itself must be created once per Lambda container (module scope in
 * `src/handler.ts`), not per request — recreating it would defeat the version cache.
 */
export function createStatusReader(dbPath: string): StatusReader {
  const state: ReaderState = { cachedEtag: null, db: undefined };

  return {
    async getStatus(store: Store, storeKey: string): Promise<StatusResult> {
      const head = await store.head(storeKey);

      // No snapshot yet — fetch has never run successfully (spec §4.3). Nothing to query.
      if (head === null) {
        return { snapshotVersion: null, sources: [], recentNotifications: [] };
      }

      const cacheHit = state.cachedEtag === head.etag && state.db !== undefined && existsSync(dbPath);

      if (!cacheHit) {
        // `better-sqlite3` keeps a page cache in memory; if the file on disk changes
        // underneath an open handle, the cache describes a file that no longer exists —
        // silently wrong answers, no error. Close before overwriting (spec §4.3).
        if (state.db !== undefined) {
          state.db.close();
          state.db = undefined;
        }
        if (existsSync(dbPath)) {
          rmSync(dbPath);
        }

        const object = await store.get(storeKey);
        if (object === null) {
          // HEAD succeeded but GET raced a delete between the two calls — treat as
          // no-snapshot rather than throwing, since the outcome the caller cares about
          // (nothing to query) is identical to the head === null branch above.
          return { snapshotVersion: null, sources: [], recentNotifications: [] };
        }

        writeFileSync(dbPath, object.body);
        state.cachedEtag = object.etag;
        state.db = openReadOnlyDatabase(dbPath);
      }

      return queryStatus(state.db as Database.Database, state.cachedEtag as string);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/status.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/status.ts tests/status.test.ts
git commit -m "feat: implement reader (status) op with version-cached hydration"
```

---

## Task 3: Wire `status` into the Lambda handler

**Files:**
- Modify: `src/handler.ts`
- Modify: `tests/handler.test.ts`

- [ ] **Step 1: Update the failing test**

Replace the `'routes op="status" to a 501 stub'` test in `tests/handler.test.ts` with:

```typescript
  it('routes op="status" through the reader and returns 200 with sources/recentNotifications', async () => {
    s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' });
    s3.on(PutObjectCommand).resolves({ ETag: '"v1"' });
    bedrock.on(ConverseCommand).resolves({
      output: { message: { content: [{ text: 'Weather update: 72F' }] } },
      stopReason: 'end_turn',
    });

    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
      DB_PATH: join(dir, 'memory.db'),
      SOURCES: '["weather"]',
    };
    const clients = { s3Client: s3 as unknown as S3Client, bedrockClient: bedrock as unknown as BedrockRuntimeClient };

    // Publish a snapshot via fetch first, then read it via status. The S3 mock is
    // stateless across commands, so this test only checks the routing and response shape,
    // not that fetch's write is visible to a fresh S3 GET — status.test.ts already covers
    // the version-cache hydration logic against a real LocalStore.
    await runHandler({ op: 'fetch' }, env, clients, { weather: async () => '72F' });

    s3.on(HeadObjectCommand).rejects({ name: 'NotFound' });
    const result = await runHandler({ op: 'status' }, env, clients);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}');
    expect(body).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });
  });
```

Add `HeadObjectCommand` to the `@aws-sdk/client-s3` import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handler.test.ts`
Expected: FAIL — handler still returns 501 for `status`

- [ ] **Step 3: Modify `src/handler.ts`**

Add the import:

```typescript
import { createStatusReader, type StatusReader } from './agent/status.js';
```

Replace the module — add a module-scope reader map (keyed by `dbPath`, matching the
pattern `aws-cloud-agent/src/reader/handler.ts` uses for its container-level cache) and
replace the `status` branch:

```typescript
/**
 * Module-scope, keyed by dbPath: the Lambda runtime may reuse the container across
 * invocations, so the reader's hydration cache (spec §4.3) must survive warm
 * invocations — recreating it per call would re-download the snapshot on every request
 * regardless of whether its ETag changed.
 */
const statusReaders = new Map<string, StatusReader>();

function getStatusReader(dbPath: string): StatusReader {
  let reader = statusReaders.get(dbPath);
  if (reader === undefined) {
    reader = createStatusReader(dbPath);
    statusReaders.set(dbPath, reader);
  }
  return reader;
}
```

Replace:

```typescript
  if (event.op === 'status') {
    // PR3 implements the reader op (spec §9 Phase 4).
    return { statusCode: 501, body: JSON.stringify({ error: 'status op not yet implemented' }) };
  }
```

with:

```typescript
  if (event.op === 'status') {
    const s3Client = clients.s3Client ?? new S3Client({ region: config.region, maxAttempts: 3 });
    const store = createS3Store({ client: s3Client, bucket: config.snapshotBucket });
    const reader = getStatusReader(config.dbPath);
    const result = await reader.getStatus(store, config.snapshotKey);
    return { statusCode: 200, body: JSON.stringify(result) };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handler.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all tests pass across PR1, PR2, PR3

- [ ] **Step 7: Commit**

```bash
git add src/handler.ts tests/handler.test.ts
git commit -m "feat: wire status op into the Lambda handler"
```

---

## Task 4: Extend `scripts/smoke.sh`

**Files:**
- Create: `scripts/smoke.sh`

No automated test — this is an operator-run script, verified manually against a deployed
stack (spec §7.3, §9 Phase 4).

- [ ] **Step 1: Write `scripts/smoke.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

echo "=== Fetching stack outputs ==="
outputs=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output json)

FUNCTION_NAME=$(echo "$outputs" | jq -r '.[] | select(.OutputKey == "AgentFunctionName") | .OutputValue')
FUNCTION_URL=$(echo "$outputs" | jq -r '.[] | select(.OutputKey == "AgentFunctionUrl") | .OutputValue')

echo "Function:     $FUNCTION_NAME"
echo "Function URL: $FUNCTION_URL"

echo ""
echo "=== Invoking fetch ==="
aws lambda invoke \
  --profile "$PROFILE" \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --payload '{"op":"fetch"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/fetch-response.json

echo "Fetch response:"
cat /tmp/fetch-response.json | jq .

echo ""
echo "=== Waiting for the run to settle ==="
sleep 5

echo ""
echo "=== Querying status ==="
# Credentials go through a 0600 netrc file, not argv — `curl --user "$key:$secret"` would
# put the secret access key in `ps aux` output for the process lifetime.
NETRC_FILE=$(mktemp)
chmod 600 "$NETRC_FILE"
trap 'rm -f "$NETRC_FILE"' EXIT
FUNCTION_HOST=$(echo "$FUNCTION_URL" | sed -E 's#^https?://([^/]+).*#\1#')
printf 'machine %s login %s password %s\n' \
  "$FUNCTION_HOST" \
  "$(aws configure get aws_access_key_id --profile "$PROFILE")" \
  "$(aws configure get aws_secret_access_key --profile "$PROFILE")" \
  > "$NETRC_FILE"

status_response=$(curl -s --aws-sigv4 "aws:amz:$REGION:lambda" \
  --netrc-file "$NETRC_FILE" \
  --header "Content-Type: application/json" \
  --data '{"op":"status"}' \
  "$FUNCTION_URL")

echo "$status_response" | jq .

weather_present=$(echo "$status_response" | jq '.sources[] | select(.name == "weather") | .lastValue')
if [ -z "$weather_present" ]; then
  echo "FAIL: no weather source with a lastValue in status response" >&2
  exit 1
fi

echo ""
echo "=== Smoke test complete ==="
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/smoke.sh`

- [ ] **Step 3: Add `smoke` script to `package.json`**

Add to `"scripts"`: `"smoke": "bash scripts/smoke.sh"`

- [ ] **Step 4: Manual verification (requires a deployed stack from PR2's Task 9)**

Run: `npm run smoke`
Expected: fetch response shows `outcome: "success"`, status response shows a `weather`
source with a non-null `lastValue`, and `recentNotifications[0].formattedMessage` is
present (matches spec §9 Phase 4 verification exactly).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.sh package.json
git commit -m "feat: extend smoke test to exercise the status op"
```

---

## Task 5: Tutorial docs

**Files:**
- Create: `README.md`
- Create: `docs/01-architecture.md`
- Create: `docs/02-rehydration.md`
- Create: `docs/03-schema.md`
- Create: `docs/04-extending.md`
- Create: `docs/05-from-tutorial-to-prod.md`

No automated test — these are prose. Verification is a read-through against the design
spec's own claims (spec §1: "Every non-obvious decision explained in `docs/`").

- [ ] **Step 1: Write `README.md`**

```markdown
# sqlite-s3-agent-tutorial

A working example of the **SQLite-as-a-database-for-an-agent-on-AWS, rehydrated-by-S3**
pattern: a Discord bot that checks the weather and Bitcoin price once a day, asks an LLM
(Amazon Bedrock) to turn the raw value into a friendly message, posts it to a Discord
webhook, and remembers what it already posted — all state lives in a single SQLite file
in S3. No database server, no VPC.

## Quick start

```bash
npm install
npm test
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run local-fetch
```

That runs the writer against a local SQLite file with no AWS involved (Phase 1). To
deploy the real thing:

```bash
export AWS_PROFILE=your-profile
npm run deploy
npm run smoke
```

Before your first deploy, grant model access for `zai.glm-4.7-flash` in the Bedrock
console (`us-east-1` → Bedrock → Model access) — see [docs/02-rehydration.md](docs/02-rehydration.md#bedrock-setup)
for why this step exists and what breaks if you skip it.

## What's here

| Doc | Covers |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | The pattern, in prose: one Lambda, two ops, one bucket |
| [docs/02-rehydration.md](docs/02-rehydration.md) | Bootstrap, conditional writes, version-cached reads |
| [docs/03-schema.md](docs/03-schema.md) | Why three tables, not one |
| [docs/04-extending.md](docs/04-extending.md) | Adding a third source |
| [docs/05-from-tutorial-to-prod.md](docs/05-from-tutorial-to-prod.md) | What changes if you outgrow this |

## Cost

At one Discord post per day, `zai.glm-4.7-flash` costs under $0.02/year. See
[docs/bedrock-model-comparison.md](docs/bedrock-model-comparison.md) for alternatives.
```

- [ ] **Step 2: Write `docs/01-architecture.md`**

```markdown
# Architecture

One Lambda function. Two operations, read as `event.op`: `fetch` (the writer, run daily by
EventBridge) and `status` (the reader, exposed by a Function URL). Both share a single
SQLite file that lives durably in one S3 object and transiently in `/tmp` for the
lifetime of one invocation.

## Why one file in S3 instead of a database server

A database server (RDS, DynamoDB) needs to exist continuously, whether or not anything is
happening. This bot runs once a day. Provisioning a server for a workload that is asleep
99.9% of the time is the wrong trade — you're paying for uptime a cron job doesn't need.
SQLite has no server: it's a file format and a library. The only question the "SQLite for
a stateful Lambda" pattern has to answer is "where does the file live between
invocations, given Lambda's `/tmp` doesn't survive a cold start?" S3 is the answer:
durable, versioned, and — critically for this pattern — supports conditional writes via
`If-Match`, which is what makes concurrent writers safe (see
[docs/02-rehydration.md](02-rehydration.md)).

## Why one Lambda, not two

`aws-cloud-agent`, the sibling project this tutorial is drawn from, uses two Lambdas — a
writer and a reader — because its reader also runs semantic search backed by a vector
index that needs its own warm-container lifecycle tuning. This tutorial's reader is a
much smaller job: query two tables and return JSON. Splitting it into a second Lambda
would mean a second container image, a second set of IAM grants, and a second cold-start
budget — for a query that returns in single-digit milliseconds once hydrated. One function
with an `op` field is simpler and the tutorial's job is to teach the storage pattern, not
Lambda topology.

## The single-writer invariant

The function is deployed with `reservedConcurrentExecutions: 1`. Without it, two
overlapping `fetch` invocations could both hydrate the same S3 version, both do their
work, and both try to publish — the second one either overwrites the first's notification
silently (if writes aren't conditional) or gets rejected with a 412 (because they are).
Reserved concurrency 1 means only one invocation of this function runs at a time, so that
race can't happen at all. The conditional write is a second line of defense that also
protects against an out-of-band `aws s3 cp` — belt and suspenders.

## EventBridge's payload

The schedule's `Input` is the literal string `{"op":"fetch"}`, not a transformed event.
EventBridge's own invocation envelope (the `detail`, `time`, `resources` fields it
normally wraps a target's input in) is not something the handler ever has to know about —
it reads `event.op` directly. A transformed input would produce the same behavior, but a
constant one is unambiguous and doesn't depend on how EventBridge's wrapper shape might
change.
```

- [ ] **Step 3: Write `docs/02-rehydration.md`**

```markdown
# Rehydration

Three mechanisms make up the pattern this tutorial exists to teach.

## 1. Bootstrap

The very first `fetch` invocation finds nothing at `s3://<bucket>/memory.db` — S3 returns
`NoSuchKey`. Rather than treating that as an error, the writer opens a brand-new, empty
SQLite file at `/tmp/memory.db` and runs `bootstrap()`, which is nothing more than
`CREATE TABLE IF NOT EXISTS` for the three tables in [docs/03-schema.md](03-schema.md).
Every subsequent invocation also runs `bootstrap()` — it's a no-op against an
already-migrated file, so there's no cost to always calling it, and it means
`npm run deploy` produces a working bot without a manual `aws s3 cp` step first.

## 2. Conditional writes

When the writer is ready to publish its updated SQLite file, it doesn't just overwrite
`s3://<bucket>/memory.db`. It sends the PUT with an `If-Match: <etag>` header, where the
etag is the one it captured when it downloaded the file at the start of the invocation.
S3 honors that header at the storage layer: if the object's current etag doesn't match —
meaning someone else wrote a newer version since this invocation started — S3 rejects the
write with `412 Precondition Failed` instead of silently clobbering it.

The bootstrap case is the one exception: there's no prior etag to match against, because
there's no prior object. The `Store` interface models this with `ifMatch: string | null` —
`null` means "omit the `If-Match` header; this is a fresh put." That keeps S3's HTTP
semantics contained inside `S3Store`; the writer's orchestration code never sees a header,
just a `string | null`.

On a 412, the writer does not retry. A blind retry would mean re-fetching from the
external weather/crypto API and re-posting to Discord against a snapshot that's already
stale — the correct response to "someone else wrote first" is to abort loudly and let the
next scheduled run pick up from the new state. Because `reservedConcurrentExecutions: 1`
already makes two overlapping writers impossible, a 412 in practice means something else
went wrong — a misconfiguration, or an out-of-band write — and failing loudly is what
surfaces that in CloudWatch.

## 3. Version-cached reads

The reader has a different problem: it may be invoked far more often than the writer (a
human hitting the Function URL to check on the bot), and most of those invocations happen
against an unchanged snapshot. Re-downloading the whole SQLite file on every request would
work, but it's wasted I/O on a warm Lambda container that already has last version on
disk.

Instead, the reader keeps the last snapshot's S3 ETag in a module-scope variable — which
survives across invocations on a warm container, because Lambda doesn't re-run module-level
code on every invoke, only on cold starts. Each request does a cheap `HEAD` first. If the
returned ETag matches what's cached and the local file still exists, the reader reuses its
already-open SQLite handle. Only when the ETag differs does it close the old handle,
delete the stale local file, download the new one, and open a fresh handle.

That "close, delete, re-download, reopen" sequence matters more than it looks: SQLite
libraries like `better-sqlite3` keep an in-memory page cache tied to the open file
descriptor. If the file on disk changes underneath an open handle — which is exactly what
happens if you just overwrite `/tmp/memory.db` without closing first — the handle's page
cache goes stale silently. Queries keep succeeding; they just return wrong answers. Closing
first is what prevents that.

## Bedrock setup

Before the first `fetch` invocation can succeed, grant model access for the configured
`bedrockModelId` (default `zai.glm-4.7-flash`) in the Bedrock console:
*Bedrock → Model access* in `us-east-1`, find *Z.AI*, tick *GLM 4.7 Flash*, save. No EULA
required for Z.AI models — Anthropic models require accepting one on the same page.

This is a one-time, per-account, per-region setting, and it's independent of IAM: `cdk
deploy` succeeds with or without it, because the CDK stack's IAM policy is generated at
synth time from the configured model's family (see `src/format/families.ts`) and is
already permissive enough. Model access is a separate gate Amazon added on top of IAM, and
until it's granted, `bedrock:InvokeModel` returns `AccessDeniedException` regardless of
what your IAM policy says. Skipping this step means the stack deploys cleanly and the
first `fetch` fails — which is why this tutorial calls it out before the first deploy
rather than after.
```

- [ ] **Step 4: Write `docs/03-schema.md`**

```markdown
# Schema

Three tables, prefixed `agent_` so a future migration never collides with anything else
that might end up sharing the database.

```sql
CREATE TABLE agent_sources (
  name TEXT PRIMARY KEY,
  last_value TEXT,
  last_fetched_at INTEGER,
  last_posted_at INTEGER,
  CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto'))
);

CREATE TABLE agent_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  value TEXT NOT NULL,
  formatted_message TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  FOREIGN KEY (source) REFERENCES agent_sources(name) ON DELETE CASCADE
);

CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  snapshot_version_in TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  sources_checked INTEGER,
  notifications_sent INTEGER,
  error TEXT
);
```

## Why three tables, not one

`agent_sources` answers "what should I skip?" — it's the dedup state, one row per source,
overwritten in place. `agent_notifications` answers "what did I actually post?" — it's an
append-only history. `agent_runs` answers "did the bot itself work?" — it's an
observability log, independent of whether any individual source produced a notification.
Merging these would make each question harder to answer: putting `last_posted_at` only on
`agent_notifications`, for instance, would turn "what's the current dedup state for
weather?" into a query that has to find the most recent row and hope nothing raced it,
instead of a primary-key lookup.

## Why both `value` and `formatted_message`

Dedup has to compare against something byte-for-byte stable: the same weather reading
should always produce the same string. The LLM-formatted message is the opposite —
non-deterministic by design, because the whole point of running it through Bedrock is to
get natural, varied phrasing. If dedup compared `formatted_message` instead of `value`,
an unchanged `72F` reading would produce a different message every time it was checked,
and the dedup logic would never fire — every run would post, defeating the entire feature
and burning an LLM call it didn't need to. `value` is what dedup reads; `formatted_message`
is what a human reads. Storing both means the reader can show what was actually posted
without paying for a second Bedrock call just to redisplay it.

## Why `outcome` and `error` are nullable

An `agent_runs` row is inserted at the *start* of a run, before any work happens, and
updated at the end. A row where `ended_at` is still `NULL` is not missing data — it's a
record that the process crashed or was killed mid-run, which is exactly the failure mode
you'd otherwise have no visibility into. Defaulting `outcome` to some placeholder value
would erase that signal.

## Why `source` is a closed vocabulary

The `CHECK` constraint on `agent_sources.name` accepts only `'weather'` and `'crypto'`. A
typo like `'wether'` would otherwise silently create a third, orphaned dedup row that
never gets checked against — the bug would look like "the weather bot stopped noticing
changes," which is a much harder thing to debug than a constraint violation at insert
time. Extending the tutorial to a third source means editing this one constraint plus one
new `SourceFetcher` — see [docs/04-extending.md](04-extending.md).
```

- [ ] **Step 5: Write `docs/04-extending.md`**

```markdown
# Extending: adding a third source

The tutorial ships with two sources — `weather` and `crypto` — deliberately, to keep the
example small. Adding a third (say, a daily quote, or a stock price) touches exactly three
places.

## 1. The schema's closed vocabulary

In `src/db/schema.ts`, add the new name to `SOURCE_NAMES`:

```typescript
export const SOURCE_NAMES = ['weather', 'crypto', 'quote'] as const;
```

The `CHECK` constraint in `AGENT_DDL` is generated from a literal SQL string, not from
`SOURCE_NAMES` — update it too:

```sql
CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto', 'quote'))
```

This is a deliberate lack of DRY: SQLite's `CHECK` clause can't reference a TypeScript
array at schema-application time, and generating SQL from the array would obscure exactly
the constraint a reader most needs to see when debugging a rejected insert. Keep the two
lists next to each other and change them together.

## 2. A `SourceFetcher`

Add `src/sources/quote.ts`:

```typescript
import type { SourceFetcher } from './types.js';

export function createQuoteFetcher(): SourceFetcher {
  return {
    name: 'quote',
    async fetch() {
      const response = await fetch('https://api.example.com/quote-of-the-day');
      if (!response.ok) {
        throw new Error(`quote API responded ${response.status}`);
      }
      const json = (await response.json()) as { quote?: string };
      if (json.quote === undefined) {
        throw new Error('quote API response missing quote field');
      }
      return json.quote;
    },
  };
}
```

Register it in `src/sources/index.ts`'s `switch` statement.

## 3. Nothing else

`src/agent/fetch.ts`, `src/format/*`, `src/agent/status.ts`, and `infra/stack.ts` all
operate on `SourceName` generically — none of them special-case `'weather'` or `'crypto'`
by name. Once the schema and the fetcher exist, `SOURCES='["weather","crypto","quote"]'`
(or the equivalent env var on the deployed function) picks up the new source with no
further code changes. That genericity is why the closed vocabulary lives in exactly one
place instead of being re-validated at every call site.

## What this tutorial deliberately doesn't support

A source registry, plugin system, or dynamic configuration of *which* sources exist at
runtime — see the design spec's §8 ("Out of scope"). Three sources or thirty, the pattern
is the same: edit the constraint, add a fetcher, register it. A registry would only pay
for itself past the point where "edit two files" stops being fast enough, and this
tutorial's job is to teach the storage pattern, not to anticipate that scale.
```

- [ ] **Step 6: Write `docs/05-from-tutorial-to-prod.md`**

```markdown
# From tutorial to production

This tutorial's defaults are chosen for clarity, not for running a real business on. If
you outgrow it, here's what changes — and `aws-cloud-agent`
(github.com/equationalapplications/aws-cloud-agent), the sibling project this pattern was
drawn from, is a working example of most of these deltas already applied.

## Bucket lifecycle

This tutorial's bucket is `RemovalPolicy.DESTROY` with `autoDeleteObjects: true`, so
`cdk destroy` cleans up completely — useful for a tutorial you might spin up and tear down
several times while learning it. A production system generally wants
`RemovalPolicy.RETAIN`: losing the bucket should require a deliberate, separate action,
not be a side effect of a stack deletion. `aws-cloud-agent` also versions its bucket and
retains every version indefinitely, because it supports restoring to a prior snapshot —
this tutorial doesn't need that if the only state that matters is "what was the last value
posted."

## More than one writer path

This tutorial has exactly one thing that writes to the snapshot: the `fetch` op, on a
fixed daily schedule. A production agent is more likely to need multiple write paths — a
scheduled job and a manually-triggered one, say — which raises the question of whether
`reservedConcurrentExecutions: 1` is still sufficient once two *different* Lambda
functions might both want to write. It isn't, on its own: reserved concurrency only
serializes invocations of one function. `aws-cloud-agent` handles this by giving every
writer path the same conditional-write discipline this tutorial uses, so the S3 `If-Match`
precondition — not Lambda's concurrency control — is what actually prevents two writers
from clobbering each other, regardless of how many entry points call into that logic.

## The single Lambda split

This tutorial's `fetch` and `status` share one function because the reader's query is
cheap. If your reader starts doing real work — search, aggregation, anything with its own
latency and memory profile — split it into its own function, the way `aws-cloud-agent`
splits writer and reader. The two functions still share the storage pattern in this
tutorial's `docs/02-rehydration.md`; only the deployment topology changes.

## Model selection

This tutorial defaults to `zai.glm-4.7-flash` for cost — the whole daily notification
costs under $0.02/year at that price point (see `docs/bedrock-model-comparison.md`). A
production system with actual latency or quality requirements should pick a model the way
`aws-cloud-agent`'s cost-rebalance design doc does: probe candidates against your real
prompt, not against a price list, and pin the choice with the same "why not something
else" reasoning that doc records.

## What stays the same

The rehydration protocol — bootstrap, conditional writes, version-cached reads — doesn't
change shape as the system grows. That's the point of the pattern: it's the same mechanism
whether the payload is a two-table dedup cache or `aws-cloud-agent`'s full knowledge graph
with a vector index. What changes is how much work happens between hydrate and publish,
not how hydrate and publish themselves work.
```

- [ ] **Step 7: Commit**

```bash
git add README.md docs/01-architecture.md docs/02-rehydration.md docs/03-schema.md docs/04-extending.md docs/05-from-tutorial-to-prod.md
git commit -m "docs: write tutorial narrative (architecture, rehydration, schema, extending, prod deltas)"
```

---

## Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test file across PR1, PR2, PR3 passes.

- [ ] **Step 2: Typecheck the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `dist/` populated, no errors.

- [ ] **Step 4: Manual end-to-end verification against a deployed stack**

Run: `npm run smoke`
Expected: matches spec §9 Phase 4's verification exactly — `curl <function-url> --data
'{"op":"status"}'` (via `smoke.sh`) returns JSON including `recentNotifications[].formattedMessage`.

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §3.2 (all 5 steps of the reader op), §4.3 (version-cached hydration,
  including the `NoSuchKey` empty-state branch and the close-before-reopen requirement),
  Phase 4's deliverables (`status` op, version cache, `scripts/smoke.sh` extended) are all
  covered by Tasks 1-4. §10's docs deliverable (`README.md` + five `docs/*.md` files) is
  Task 5. `agent_runs` population itself was already implemented in PR1 (`runLog.ts`) and
  exercised end-to-end in PR1's `fetch.test.ts` — this PR's job was making that data
  *visible* via the reader, which Task 2 covers.
- **Type consistency:** `StatusResult`, `SourceStatus`, and `NotificationStatus` are
  defined once in `src/agent/status.ts` and used unchanged in `src/handler.ts`'s response
  serialization (Task 3) and in `tests/status.test.ts` / `tests/handler.test.ts`'s
  assertions — no field renamed between definition and use (`formattedMessage`, not
  `formatted_message`, in every JSON-facing spot).
