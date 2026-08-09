# SQLite S3 Agent Tutorial — Design

**Date:** 2026-08-08
**Status:** Implemented (PR3) + state-invariants hardened (PR4)
**Scope:** Public tutorial teaching the SQLite-backed-by-S3 pattern for a stateful AWS agent, by way of a working Discord notification bot.

---

## 1. Purpose and constraints

A public tutorial that teaches the **SQLite-as-a-database-for-an-agent-on-AWS, rehydrated-by-S3** pattern, by way of a concrete working example: a Discord notification bot that fetches a daily weather (or crypto) value, uses an LLM (via Amazon Bedrock) to turn the raw value into a friendly message, posts it to a Discord webhook on a cron schedule, and persists state in a single SQLite file in S3.

The tutorial is built so that `npm run deploy` produces a working bot end-to-end on the first try, then walks through the moving parts in `docs/`.

**Constraints that shape every decision below:**

- **Standalone.** Reusable as a starting point for any agent with persistent state. No coupling to any external repo.
- **TypeScript, Node 24, ESM.** Modern, ESM-native, strict.
- **Public tutorial quality.** Every non-obvious decision explained in `docs/`. No "we do X because reasons" — the *why* is the value.
- **No VPC, no DB server.** SQLite file in S3, hydrated to `/tmp` per invocation.
- **Region pinned to `us-east-1`.** AWS CDK, single stack, single S3 bucket.
- **Single-user.** No multi-tenancy, no auth beyond Discord webhook secrecy.

**What "agent" means here:** any program that reads from and writes to a small persistent store on a recurring cadence, with no requirement for long-running processes. The pattern generalises to scheduled reporters, polling crawlers, stateful cron jobs, periodic reconcilers — anything where (a) the work is bounded and per-invocation, and (b) the state must survive between invocations without a database server.

---

## 2. Architecture

One Lambda function, two ops, one S3 bucket, one SQLite file.

```
┌──────────────────┐                    ┌─────────────────────────────┐
│ EventBridge      │  cron (rate: 1d)   │                             │
│ schedule         ├───────────────────►│   agent Lambda (arm64)      │
└──────────────────┘   {op:"fetch"}     │   ┌─────────────────────┐   │
                                       │   │ op = "fetch"        │   │
                                       │   │  1. hydrate DB      │   │
                                       │   │  2. fetch external  │   │
                                       │   │  3. dedup vs state  │   │
┌──────────────────┐                    │   │  4. format via LLM  │   │
│ Amazon Bedrock   │ ◄── Converse ──────┤   │  5. post to Discord │   │
│ (zai.glm-4.7-    │  prompt / reply    │   │  6. upload new DB   │   │
│  flash)          │                    │   │     (If-Match)      │   │
└──────────────────┘                    │   └─────────────────────┘   │
                                       │   ┌─────────────────────┐   │
                                       │   │ op = "status"       │   │
                                       │   │  1. hydrate or reuse│   │
                                       │   │  2. query state     │   │
                                       │   │  3. return JSON     │   │
                                       │   └─────────────────────┘   │
                                       │             │               │
                                       │             ▼               │
                                       │   ┌─────────────────────┐   │
                                       │   │ /tmp/memory.db      │◄──┼─── hydrate
                                       │   └─────────────────────┘   │    (S3 GetObject)
                                       │             │               │
┌──────────────────┐                    │             ▼               │
│ Discord webhook  │ ◄────── POST ──────┤   ┌─────────────────────┐   │
│ (user-supplied)  │  formatted msg     │   │ s3://<bucket>/      │   │
└──────────────────┘                    │   │   memory.db         │   │
                                       │   │  (versioned,        │   │
                                       │   │   single object)    │   │
                                       │   └─────────────────────┘   │
                                       │             ▲               │
                                       │             │               │
┌──────────────────┐  {op:"status"}     │             │               │
│ HTTP client      ├───────────────────►│   Function URL (read-only) │
│ (curl, browser)  │                    │                             │
└──────────────────┘                    └─────────────────────────────┘
```

**One function, two ops.** The Lambda reads `op` from the event payload (EventBridge → `fetch`, Function URL → `status`). The container image and role are identical.

**EventBridge payload routing.** The schedule rule's `Input` target is configured as a constant JSON string `{"op": "fetch"}` — not a transformed event payload — so the handler reads `event.op` directly without having to unwrap EventBridge's `detail` envelope. A transformed input would still produce the same runtime behaviour, but a constant input is unambiguous and survives IAM-policy changes that affect EventBridge's wrapper shape.

**LLM message formatting.** Between the value fetch and the Discord post, the writer calls Amazon Bedrock (default `zai.glm-4.7-flash`) to turn the raw value into a friendly message. Dedup runs on the raw `value` *before* the LLM call (§3.1 step 3), so unchanged values never invoke Bedrock — the model is paid for only when there's actually something new to say. The model choice is overridable per environment via `bedrockModelId` (§11). The same `MessageFormatter` interface is implemented by `LocalTemplateFormatter` (Phase 1, no AWS) and `BedrockFormatter` (Phase 3, default), so the writer's hot path doesn't change between local and deployed.

**`fetch` is the writer; `status` is the reader.** Both read and write the same single S3 object, but each keeps its own local copy under `/tmp`: the writer at `${DB_PATH}` (default `/tmp/memory.db`), the reader at `${DB_PATH}.reader` (default `/tmp/memory.db.reader`). The split matters because the writer mutates its local file on every invocation, including the conditional-write failure path where S3 rejects the PUT with 412 and the writer records the `outcome='error'` run row locally — the S3 ETag does not change in that branch, so a reader sharing the writer's path would see an ETag cache hit and answer from the still-open reader handle against the writer's mutated bytes. Keeping the two local paths disjoint means the reader's local copy only changes when the reader itself downloads a new snapshot. The reader's job is to make the writer's state visible — without it, the only way to inspect the bot is `aws s3 cp` and `sqlite3`, which is bad tutorial UX. The reader is a JSON endpoint, not a UI: callers (`curl`, `aws lambda invoke`, browser address bar) see `sources[]` and `recentNotifications[]`, not a dashboard.

**Single-writer invariant.** The function has `reservedConcurrency: 1`. Without it, two simultaneous `fetch` invocations could both hydrate the same version, both upload, and silently overwrite each other's writes. The `status` op is read-only by IAM (`s3:GetObject` only, no `s3:PutObject`), so the writer's state is safe even though it shares the role.

---

## 3. Data flow

### 3.1 `fetch` op (the writer)

```
1.  S3 GetObject on s3://<bucket>/memory.db
    - 404 → bootstrap branch (§4.1)
    - 200 → /tmp/memory.db, capture ETag
2.  better-sqlite3 open /tmp/memory.db (WAL, immutable=false)
3.  bootstrap() — CREATE TABLE IF NOT EXISTS agent_sources, agent_notifications, agent_runs (§5)
4.  BEGIN; INSERT agent_runs (run_id, op='fetch', snapshot_version_in, started_at); COMMIT
5.  For each configured source (e.g. weather, crypto):
    a. Fetch external value (HTTPS GET via SourceFetcher)
    b. Read agent_sources.last_value for this source
    c. If new value == last_value, skip (no Discord post, no agent_notifications row, no LLM call — the model is paid for only when there is something new to say)
    d. Else:
       i. Call `MessageFormatter.format(source, raw_value)` → friendly message
          (`BedrockFormatter` in Phase 3; `LocalTemplateFormatter` in Phase 1, §7.1).
       ii. POST formatted message to Discord webhook.
       iii. On 2xx, INSERT agent_notifications (source, value, formatted_message, posted_at);
            UPDATE agent_sources SET last_value = ?, last_posted_at = ?.
6.  UPDATE agent_runs SET ended_at, outcome, sources_checked, notifications_sent, error
7.  S3 PutObject to s3://<bucket>/memory.db with If-Match: <ETag>
    - 412 PreconditionFailed → log, abort, leave old version authoritative
8.  close()
```

### 3.2 `status` op (the reader)

```
1.  HEAD on s3://<bucket>/memory.db; capture ETag
2.  If module-scope cached ETag equals current and /tmp/memory.db.reader exists:
    reuse, open read-only handle
3.  Else: close any open handle, rm /tmp/memory.db.reader, GetObject → /tmp/memory.db.reader,
   cache ETag, open read-only handle
4.  Query: SELECT name, last_value, last_fetched_at, last_posted_at FROM agent_sources
           + last N rows from agent_notifications JOIN agent_sources
5.  Return JSON: { snapshotVersion, sources: [...], recentNotifications: [...] }
```

The version cache (§4.3) is what makes warm invocations cheap. The mechanism is the same one any warm-cache pattern uses: hold a pointer to the last loaded resource, validate it against the source's current version on each access, and reload only when it has changed. The tutorial teaches that mechanism in its simplest form.

---

## 4. Rehydration protocol

Three mechanisms, each teaching one part of the pattern.

### 4.1 Bootstrap (writer's first run)

When `S3.GetObject` returns `NoSuchKey`:

1. Open `/tmp/memory.db` with `better-sqlite3`. Empty file.
2. Run `bootstrap()`: create the three tables (§5). Idempotent.
3. Continue the normal write flow with `null` as the `ifMatch` argument to `Store.put` (§4.2) — there is no prior version to match against.

On subsequent runs, `S3.GetObject` returns 200 and bootstrap is skipped. The branch exists to make `npm run deploy` succeed on day one without a manual `aws s3 cp` step.

### 4.2 Conditional write (writer's PUT)

The writer calls `Store.put(key, body, ifMatch)`. The `ifMatch` argument is the only place where S3's HTTP semantics enter the picture — and even there they are contained: `S3Store` translates the argument into the appropriate header on the wire, and the writer never sees that translation.

- **Normal case (`ifMatch: <ETag>`)** → `S3Store` sends `If-Match: <ETag>` (the ETag captured during the corresponding `GetObject`). 200 OK → success, capture the new ETag for the run record.
- **Bootstrap case (`ifMatch: null`)** → `S3Store` omits the `If-Match` header on the wire. S3 treats the request as a fresh put, creating the object. `null` is the bootstrap indicator inside the agent's domain: it carries the same intent that a `*` wire-sentinel would, but it stays inside `S3Store` instead of leaking into the agent code.
- **412 Precondition Failed** → another writer committed while this one worked. **Abort loudly, do not retry.** A blind retry would re-fetch from the external API and re-post to Discord against a stale base. Since `reservedConcurrency: 1` makes this race impossible, 412 means a misconfiguration or an out-of-band write — either way, fail is the correct response.

### 4.3 Version-cached read (reader's hydration)

The reader keeps the last hydrated ETag in module scope. Each invocation:

1. `HEAD s3://<bucket>/memory.db`. Capture current ETag.
2. If module-scope ETag equals current ETag and `/tmp/memory.db.reader` exists: open a read-only handle to the existing file.
3. Else: close any open handle, `rm /tmp/memory.db.reader`, `GetObject` → `/tmp/memory.db.reader`, open a read-only handle, update module-scope ETag. **If `GetObject` returns `NoSuchKey`** (no snapshot yet — `fetch` has never run successfully), return the empty-state JSON — `{ snapshotVersion: null, sources: [], recentNotifications: [] }` — without opening a handle. There is nothing to query until the writer has produced at least one snapshot.

**Why a separate local path from the writer's.** The writer mutates its local copy on every invocation — including the conditional-write failure path, where a 412 from S3 leaves the writer's local file with the `outcome='error'` run row recorded but S3's ETag unchanged. If the reader shared the writer's local path, the reader's ETag cache hit would answer from the still-open reader handle against those locally-mutated bytes, even though the authoritative S3 snapshot did not change. Disjoint local paths keep the reader's view strictly in step with what the writer has actually published.

**Why close-and-reopen rather than reuse the open handle?** `better-sqlite3` keeps a page cache in memory. If the file on disk changes underneath an open handle, the cache describes a file that no longer exists — silently wrong answers, no error. Closing the handle before overwrite is what prevents that.

The version cache is what makes warm reader invocations cheap. On a warm Lambda, an unchanged DB costs a `HEAD` and a query. A cold Lambda or a new snapshot pays one `GetObject` and one handle open. This is the headline benefit of the pattern; the tutorial teaches it explicitly.

### 4.3.1 Partial-failure state invariants

The reader's `ReaderState` has two fields — `cachedEtag` and `db` — and exactly two valid combinations:

- `(cachedEtag: <string>, db: <open handle>)` — the cache holds a valid snapshot.
- `(cachedEtag: null, db: undefined)` — the cache is empty.

Any other combination is a bug. The cache-miss branch transitions to `(null, undefined)` at entry (when it closes the prior open handle) and only restores `(string, open handle)` after `openReadOnlyDatabase` succeeds. This makes the invariant hold across every failure mode:

- **`openReadOnlyDatabase` throws** (corrupted snapshot, non-SQLite bytes, disk error), or **`rmSync` / `writeFileSync` / `store.get` throws**: the cache was already cleared at the top of the branch, so `state.db` is `undefined` and `state.cachedEtag` is `null`. The error propagates up — the Lambda returns 500, the next call retries the cache-miss path from a known-empty state.
- **`GetObject` returns `null` after a successful `HEAD`** (transient S3 race, object deleted between calls): the cache was already cleared at the top of the branch, so the empty-state JSON is returned and the next call retries cleanly.
- **`GetObject` returns `NoSuchKey`** (no snapshot yet — `fetch` has never run): identical to the `null` case above.

The retry loop on a permanently broken S3 object is unavoidable — it terminates when the operator or the writer fixes the underlying object. The invariant is what prevents the loop from behaving incorrectly (e.g., returning stale data from a closed handle) while it runs.

---

## 5. Schema

Three tables, prefixed `agent_` so future migrations stay collision-free.

```sql
CREATE TABLE agent_sources (
  name              TEXT PRIMARY KEY,
  last_value        TEXT,
  last_fetched_at   INTEGER,                    -- unix ms
  last_posted_at    INTEGER,                    -- unix ms; null if never posted
  CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto'))
);

CREATE TABLE agent_notifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source             TEXT    NOT NULL,
  value              TEXT    NOT NULL,                       -- raw fetched value (for dedup)
  formatted_message  TEXT    NOT NULL,                       -- LLM-formatted Discord message
  posted_at          INTEGER NOT NULL,
  FOREIGN KEY (source) REFERENCES agent_sources(name) ON DELETE CASCADE
);
CREATE INDEX idx_agent_notifications_source_posted_at
  ON agent_notifications(source, posted_at DESC);

CREATE TABLE agent_runs (
  run_id              TEXT PRIMARY KEY,
  op                  TEXT NOT NULL,             -- 'fetch' | 'status'
  snapshot_version_in TEXT NOT NULL,             -- ETag that was hydrated
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,                   -- null if the run crashed mid-way
  outcome             TEXT,                      -- 'success' | 'error'
  sources_checked     INTEGER,
  notifications_sent  INTEGER,
  error               TEXT,                      -- human-readable on failure
  CONSTRAINT chk_op      CHECK (op IN ('fetch', 'status')),
  CONSTRAINT chk_outcome CHECK (outcome IS NULL OR outcome IN ('success', 'error'))
);
```

**Why three tables, not one.** `agent_sources` is the dedup state (the *what to skip*); `agent_notifications` is the *history*; `agent_runs` is the *observability log*. Conflating them — e.g. putting `last_posted_at` on `agent_notifications` — makes dedup queries depend on table scans and makes per-source "last N" queries ambiguous.

**Why both `value` and `formatted_message`.** Dedup compares the raw fetched value (`72F` vs `72.1F`) — a stable, byte-for-byte check. The LLM-generated message is downstream of dedup and never used for it. Storing both lets the status op show what was posted without recomputing the LLM call, and lets future schema migrations (e.g. switching models) leave the dedup state untouched.

**`outcome` and `error` are nullable on purpose.** A run row inserted at step 4 of the writer lifecycle (§3.1) and never updated is itself a record: "this run started and never finished." That signal is lost if the columns default to a fake value.

**`source` is a closed vocabulary.** `weather` and `crypto` only. The tutorial is intentionally narrow — readers extend it by editing one CHECK constraint and one fetch function, not by designing a registry. The constraint prevents typos like `wether` from silently producing empty dedup state.

---

## 6. Error handling

Categorised, with the right response for each. The reader of the tutorial should be able to map every AWS error class to a clear "what happens" without reading code.

| Failure | Where it surfaces | What we do |
|---|---|---|
| External API 4xx/5xx or timeout | per-source fetch | Skip that source. Append a description to `agent_runs.error`. Continue with other sources. The run completes its loop and ends with `outcome = 'success'`; the per-source failures live in the `error` column. |
| Bedrock `AccessDeniedException` | per-source LLM call | Skip the post for that source. Append a description to `agent_runs.error` pointing at §12 (model access / IAM). Do not retry: an access failure is not transient. |
| Bedrock `ValidationException` | per-source LLM call | Skip the post. Append a description naming the rejected field. Almost always a model-family mismatch (§12); only relevant when the reader swaps `bedrockModelId`. |
| Bedrock `ResourceNotFoundException` | per-source LLM call | Skip the post. Append a description naming the configured id and region. The id is mistyped or the region does not carry the model. |
| Bedrock `ThrottlingException` / 5xx | per-source LLM call | One retry within the invocation (~500ms backoff). Two failures → skip the post for that source. Append to `agent_runs.error`. The AWS SDK's adaptive retryer is layered on top of this for *transient* 5xx. |
| Bedrock malformed response (no `output.message.content`) | per-source LLM call | Skip the post. Append a description. Do not retry — malformed responses are deterministic for a given model. |
| Discord webhook 4xx | per-source post | Skip the `sources.last_posted_at` update and the `agent_notifications` insert for that source. The next run will retry. Append to `agent_runs.error`. |
| Discord webhook 5xx | per-source post | Same as 4xx, but a single retry within the invocation (one retry, ~250ms backoff). Two failures → skip the source for this run. Append to `agent_runs.error`. |
| S3 conditional write 412 | step 7 of `fetch` | **Abort loudly.** Do not retry, do not upload, do not update the local DB further. The previous snapshot stays authoritative. Update the in-progress `agent_runs` row with `outcome = 'error'` and a description of the 412, then propagate. EventBridge retries on invocation failure are disabled for this op — the failure is informational, not transient. |
| S3 `GetObject` 5xx (not 404) | step 1 of `fetch` | Bubble up. Lambda marks invocation failed. EventBridge retries with backoff. No `agent_runs` row is written (we never got far enough). |
| Bootstrap error (S3 403, IAM) | step 1 of `fetch` | Bubble up. Clear configuration error, surfaced in CloudWatch. |
| SQLite open / DDL error | step 2-3 of `fetch` | Bubble up. Previous snapshot is untouched. |
| Reader cache stale (version changed) | step 3 of `status` | Close existing handle, re-download. Idempotent. |

**`outcome = 'error'` is reserved for failures that abort the whole run after step 4** (i.e., after the `agent_runs` row has been inserted). Per-source failures inside the loop set `outcome = 'success'` and append to `agent_runs.error`; the run still completes its loop. Failures before step 4 bubble up and leave no `agent_runs` row — they appear in CloudWatch only.

**The principle: every error category has exactly one right answer, and it's the same answer every time.** The tutorial teaches a habit, not just a pattern.

**`agent_runs.error` is one column, plural messages concatenated.** Per-source failures inside a multi-source run are joined with `; `. The tutorial teaches "one column per log line" rather than a sidecar table, because the table is a tutorial artefact, not a query surface.

---

## 7. Testing

Tests run against a **real SQLite file** with a real `better-sqlite3` handle — no mocks of the database. The library's actual behaviour is the thing under test, not a re-implementation of it. Network boundaries are mocked because Discord and external APIs are out of our control.

**Runner and scripts.** The test runner is Vitest. `npm test` invokes `vitest run` via the `test` script in `package.json`; `vitest.config.ts` (see §10) is the runner config. The same script is what `npm run local-fetch` and the phases in §9 reference — the reader's CLI experience matches the text without any runner translation in between.

### 7.1 What we mock, what we don't

| Boundary | Mocked? | How |
|---|---|---|
| `better-sqlite3` | No | Real SQLite file in `/tmp` per test. |
| S3 client | Yes | `aws-sdk-client-mock`. |
| Discord webhook | Yes | A `DiscordPoster` interface; production = real `fetch`, tests = in-memory recorder. |
| External value API | Yes | A `SourceFetcher` interface keyed by source name; production = real `fetch`, tests = returns canned values. |
| `MessageFormatter` (Bedrock) | Yes | A `MessageFormatter` interface; production = `BedrockFormatter` (real `Converse` call against `bedrockModelId`), tests = `LocalTemplateFormatter` (same interface, deterministic output, no AWS). The writer is tested with `LocalTemplateFormatter`; the formatter itself is tested by separate unit tests that mock the Bedrock client. |

### 7.2 Trap guards

- **Bootstrap is idempotent.** Run `bootstrap()` on an empty DB twice; assert no schema errors, no data loss.
- **Dedup is correct.** Insert `agent_sources` row with `last_value = '72F'`. Run the writer with a new fetch returning `'72F'`. Assert no `agent_notifications` row inserted, no `last_posted_at` change, and the `MessageFormatter` was never invoked.
- **Dedup on real change.** Same setup, new fetch returns `'73F'`. Assert exactly one `agent_notifications` row with `formatted_message` non-null, `last_value = '73F'`, `last_posted_at` updated.
- **Partial-source failure doesn't poison the run.** Mock weather fetch to throw, crypto fetch to succeed. Assert the run row records the error, the notification is inserted, and the run outcome is `success`.
- **LLM failure doesn't poison the run.** Mock weather formatter to throw, crypto formatter to succeed. Assert the weather notification is *not* inserted, the crypto notification *is*, and the run outcome is `success`. The Bedrock 5xx-then-retry path is covered by a separate unit test on the formatter.
- **Conditional write 412 is honored.** Mock S3 to return 412 on `PutObject`. Assert no upload occurred and the previous version is untouched (verified by reading the local DB before the abort).
- **Reader cache invalidation.** Set cached ETag to a value different from current. Assert a fresh `GetObject` happens. Set them equal; assert no `GetObject` happens.
- **Closed vocabulary.** Insert `agent_sources(name = 'wether')` and assert CHECK constraint failure.

### 7.3 Smoke test

`scripts/smoke.sh` invokes the deployed `fetch` op, waits for the run, then invokes `status` and asserts the JSON contains a `weather` source with a `lastValue`. Tutorial readers can run it after deploy to verify end-to-end.

---

## 8. Out of scope

Deliberate. Not built, even where it appears to be the natural next step.

- **A web dashboard.** The reader is a JSON endpoint (§2). A dashboard is a separate tutorial.
- **Multi-tenancy, multiple Discord channels.** The tutorial targets one webhook. Configuration extension is left to the reader.
- **Vector search, embeddings, semantic dedup.** Dedup is byte-for-byte equality on the source value. If "weather changed from 72F to 72.0F" should count as a change, that's a future tutorial's problem. LLM output (the friendly message) is *not* used for dedup — only the raw fetched value is.
- **An ontology, semantic retrieval profiles, episodic memory tiers, outbox patterns.** All project-specific concepts that grew up around richer knowledge-graph workloads, intentionally omitted.
- **VPC, NAT Gateway, RDS, Aurora, DynamoDB.** A single SQLite file in S3 is the whole storage layer.
- **Multi-region replication, cross-region disaster recovery.** Single-region, single-bucket.
- **Adaptive cron, schedule overrides, conditional schedules.** The EventBridge schedule is a static rate expression.
- **A separate `agent_reviews` table, human review CLI, judgment tiers.** All out.

The tutorial's value is the pattern. Anything that doesn't serve that goal is removed before it adds lines.

---

## 9. Phases

Order matters: each phase produces a working artefact before the next begins. Stop after each phase; demonstrate what runs.

| Phase | Deliverable | Verification |
|---|---|---|
| **1 — Local** | SQLite schema + `bootstrap()` + dedup logic + an in-memory `DiscordPoster` and `SourceFetcher` + a `LocalTemplateFormatter` (no AWS). A CLI script (`npm run local-fetch`) runs the writer end-to-end against `/tmp/memory.db`. | Run the script; assert the DB has the right rows. Run `npm test`. |
| **2 — S3 rehydration** | `S3Store` class: `get`, `put` (with `If-Match`), `head`. Bootstrap branch. Conditional write. Real S3 (or LocalStack) behind a config flag. | `npm run local-fetch -- --s3` hydrates from S3, runs, uploads; `npm run s3-fetch` does the same against a real bucket. |
| **3 — Lambda + Bedrock** | Container image, CDK stack, EventBridge schedule, Function URL, Bedrock IAM. Reserved concurrency 1. Single IAM role scoped to the one bucket and the one Bedrock model. `BedrockFormatter` swapped in via config (default `bedrockModelId`). `scripts/deploy.sh`. **One-time console prerequisite:** enable model access in the Bedrock console for the chosen `bedrockModelId` (§12). | `npm run deploy`; `aws lambda invoke` against the deployed function for both ops; `scripts/smoke.sh` end-to-end. |
| **4 — Reader + run logs** | `status` op, version cache, `agent_runs` populated on every fetch invocation. `scripts/smoke.sh` extended to query status. | `curl <function-url> --data '{"op":"status"}'` returns the expected JSON, including `recentNotifications[].formattedMessage`. |

The CDK deploy is in phase 3, not phase 1, because tutorial readers should be able to see the local behaviour before CDK enters the picture. Splitting phases this way also means `npm run deploy` is the *last* thing a reader does, not the first — which is the right order for understanding.

**CDK cleanup ergonomics.** The bucket declared in `infra/stack.ts` is configured with `RemovalPolicy.DESTROY` *and* `autoDeleteObjects: true` so that `cdk destroy` succeeds even when the bucket contains the SQLite snapshot. Without `autoDeleteObjects`, CloudFormation refuses to delete a non-empty bucket and the stack is orphaned; readers running `cdk destroy` to avoid lingering costs would have to manually `aws s3 rm` the snapshot first. Both flags are tutorial-quality defaults — production code generally wants `RemovalPolicy.RETAIN` and explicit lifecycle ownership — and the spec documents this delta explicitly so the choice is not read as carelessness.

---

## 10. Repo layout

```
sqlite-s3-agent-tutorial/
├── README.md
├── docs/
│   ├── 01-architecture.md           # the pattern, in prose
│   ├── 02-rehydration.md            # §4 in long form
│   ├── 03-schema.md                 # §5 in long form
│   ├── 04-extending.md              # how to add a third source
│   └── 05-from-tutorial-to-prod.md  # the deltas vs running this in production
├── infra/
│   ├── stack.ts                     # CDK: bucket, function, schedule, URL
│   └── cdk.json
├── src/
│   ├── config.ts                    # typed env config, validated at load
│   ├── db/
│   │   ├── schema.ts                # DDL as constants
│   │   ├── bootstrap.ts             # idempotent CREATE TABLE IF NOT EXISTS
│   │   └── open.ts                  # better-sqlite3 factory
│   ├── store/
│   │   ├── s3.ts                    # get/put/head with If-Match
│   │   └── local.ts                 # same interface, against /tmp
│   ├── sources/
│   │   ├── index.ts                 # registry: name → SourceFetcher
│   │   ├── weather.ts               # SourceFetcher implementation
│   │   └── crypto.ts                # SourceFetcher implementation
│   ├── discord/
│   │   └── poster.ts                # DiscordPoster interface + impl
│   ├── format/
│   │   ├── index.ts                 # MessageFormatter interface
│   │   ├── local.ts                 # LocalTemplateFormatter (Phase 1, no AWS)
│   │   └── bedrock.ts               # BedrockFormatter (Phase 3, default)
│   ├── agent/
│   │   ├── fetch.ts                 # the writer op
│   │   ├── status.ts                # the reader op
│   │   └── runLog.ts                # agent_runs insert/update helpers
│   └── handler.ts                   # Lambda entry: routes by op
├── scripts/
│   ├── deploy.sh
│   └── smoke.sh
├── tests/
│   ├── db.test.ts
│   ├── fetch.test.ts
│   ├── status.test.ts
│   ├── s3.test.ts                   # with aws-sdk-client-mock
│   ├── format.test.ts               # MessageFormatter contract (LocalTemplateFormatter)
│   ├── bedrock.test.ts              # BedrockFormatter with aws-sdk-client-mock
│   └── bootstrap.test.ts
├── Dockerfile                       # arm64 cross-compile block
├── package.json
├── tsconfig.json
├── tsconfig.check.json
└── vitest.config.ts
```

`docs/01-architecture.md` is the tutorial's *narrative*. The code is the working example; the docs explain why each piece exists. `docs/05-from-tutorial-to-prod.md` is a closing piece that describes what changes when this tutorial's defaults are no longer the right trade-offs — a checklist for readers who outgrow it.

---

## 11. Configuration surface

A single typed config module (`src/config.ts`), environment-overridable. **No other module reads `process.env`**, and no magic numbers live anywhere else.

```
region                        AWS_REGION, default us-east-1
snapshotBucket                required; no default — the one value that cannot be guessed
snapshotKey                   default memory.db
dbPath                        default /tmp/memory.db

discordWebhookUrl             required; no default — the bot's destination
sources                       JSON array; default ["weather","crypto"]; checked against schema CHK

bedrockModelId                default zai.glm-4.7-flash
                              resolved at load against the format family registry (§12); an unknown id fails startup, not first invoke
bedrockRegion                 default us-east-1; must agree with the IAM resource ARN scope (§12) — set explicitly if region changes
bedrockMaxOutputTokens        default 512 — a friendly message is short; capping it prevents runaway Converse responses on a misconfigured prompt

reservedConcurrency           default 1
```

Two things are deliberately *not* in here.

**The AWS CLI profile.** `llm-wiki-admin` (or whatever profile the reader uses) is a deployment-time concern, read from `AWS_PROFILE` by `scripts/deploy.sh`. A Lambda has an execution role, not a CLI profile; putting it in the runtime config would imply the running system could use it.

**The external API keys.** Weather and crypto APIs that need keys should read them from their own env vars at fetch time, not from a global config. The tutorial will use key-free public endpoints (`wttr.in`, `coingecko`) for the demo; readers plugging in a paid API extend the fetcher interface, not the config.

**What the config validates, it validates at load.** `snapshotBucket` throws when absent rather than defaulting; `sources` rejects anything outside the closed vocabulary; numeric variables that don't parse throw naming themselves. Each of these turns what would otherwise be an opaque runtime failure into a startup error that says what to fix.

---

## 12. Bedrock setup

The single Bedrock call in the writer (§3.1 step 5d-i) requires four things to line up before the first deploy succeeds. Each is below, named in the order it will trip up a tutorial reader who skips them.

### 12.1 Model access (one-time console action)

The Bedrock console's *Model access* page controls which model ids are invocable from this AWS account in this region. Until access is granted, `bedrock:InvokeModel` returns `AccessDeniedException` regardless of IAM — and IAM is permissive by default in this tutorial, so the failure mode is "deploys fine, breaks on first invoke."

For the default `zai.glm-4.7-flash`: navigate to *Bedrock → Model access* in `us-east-1`, find the *Z.AI* provider, tick *GLM 4.7 Flash*, save. No EULA is required for Z.AI models.

For Anthropic models (alternative): same page; *Anthropic* → tick the chosen Claude model → accept the EULA in the same dialog. EULA acceptance is recorded against the AWS account and persists across deploys.

`cdk deploy` succeeds without this step (IAM is permissive); the failure surfaces only at first `fetch` invoke, which is the worst possible place to learn about model access. The tutorial walks through this *before* the first deploy.

### 12.2 IAM (auto-provisioned by CDK)

The CDK stack grants the Lambda role `bedrock:InvokeModel` + `bedrock:Converse` on the foundation-model ARN for the configured `bedrockModelId` family. No manual IAM step is required — the CDK pattern is selected from the family at synth time and the resource ARN narrows to match.

| Family | Resource ARN pattern |
|---|---|
| `zai` (default) | `arn:aws:bedrock:us-east-1::foundation-model/zai.glm-4.7-flash` |
| `amazon.nova` (bare) | `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-*` |
| `amazon.nova` (`us.`) | `arn:aws:bedrock:us-east-1:${account}:inference-profile/us.amazon.nova-*` + foundation-model ARN |
| `anthropic.claude` (`global.`) | `arn:aws:bedrock:us-east-1:${account}:inference-profile/global.anthropic.claude-*` + wildcard-region foundation-model ARN |

Picking a model whose family the stack does not know produces a *narrower* IAM grant than intended; the failure is `AccessDeniedException` at first invoke. This is the deliberate alternative to a wildcard grant — the tutorial teaches least privilege, not convenience.

### 12.3 Inference-profile prefix

Each model family accepts a specific set of prefixes on its id (`global.`, `us.`, or bare):

| Family | Default prefix | Other valid |
|---|---|---|
| `zai` | bare (`zai.glm-4.7-flash`) | — |
| `amazon.nova` | bare | `us.` |
| `anthropic.claude` | `global.` | `us.` |

The `format` family registry (`src/format/index.ts`) resolves the base id to a family at load time, validates the prefix, and rejects mismatches with a *startup error* rather than a runtime `ResourceNotFoundException` on every `fetch`. Configuring `bedrockModelId` with a prefix already in it is also rejected at load — the prefix is supplied by the family, not the user.

### 12.4 Runtime failure modes

Each Bedrock exception maps to one recovery action; the `Converse` wrapper in `BedrockFormatter` adds the fully qualified id, the region, and the family to the message so the failure is self-locating.

| Bedrock exception | Meaning | Recovery |
|---|---|---|
| `AccessDeniedException` | Model access not granted (§12.1), or IAM ARN does not cover the configured id. | §12.1 first; if access is enabled, the §12.2 pattern does not match the family. |
| `ValidationException` | Request body used an unsupported field (almost always a registry entry added without a live probe). | Re-probe the model against Bedrock before changing the registry. |
| `ResourceNotFoundException` | The composed id (with prefix) does not exist in the region. | Check `bedrockModelId` is the *base* id — no prefix; the prefix is added by the registry. |
| `ThrottlingException` / 5xx | Transient. | One retry (~500ms), two failures skip the post (§6). |

### 12.5 Swapping the model

1. Pick a model id from the Bedrock catalog.
2. Enable it in *Model access* (§12.1) — including EULA acceptance for Anthropic.
3. Update `bedrockModelId` in `src/config.ts` (or env).
4. If the family is not `zai`, add a registry entry — *only after a live probe* of accepted prefixes and request shape. The four-step procedure is mandatory, including the negative control: some families accept unknown request fields silently, so "the request did not 400" is not evidence a field is supported.
5. Re-run `cdk synth` and `cdk deploy` — the IAM grant narrows or widens to match the new family.

### 12.6 Cost reference

`zai.glm-4.7-flash` at $0.07 / $0.40 per 1M tokens (us-east-1, standard on-demand). Each `fetch` invocation that produces a notification spends roughly 50–100 input tokens and 60–100 output tokens, or ~$0.00005 per post. Annual cost at one post per day is under $0.02. Alternatives and their per-token costs are documented in `docs/bedrock-model-comparison.md` (the file is intentionally kept general-purpose, not sibling-project-specific).
