# SQLite S3 Agent Tutorial — Design

**Date:** 2026-08-08
**Status:** Draft (awaiting user review)
**Scope:** Public tutorial teaching the SQLite-backed-by-S3 pattern for a stateful AWS agent, by way of a working Discord notification bot.

---

## 1. Purpose and constraints

A public tutorial that teaches the **SQLite-as-a-database-for-an-agent-on-AWS, rehydrated-by-S3** pattern, by way of a concrete working example: a Discord notification bot that fetches a daily weather (or crypto) value, posts a formatted message to a Discord webhook on a cron schedule, and persists state in a single SQLite file in S3.

The tutorial is built so that `npm run deploy` produces a working bot end-to-end on the first try, then walks through the moving parts in `docs/`.

**Constraints that shape every decision below:**

- **Standalone.** No coupling to `aws-cloud-agent`, `core-llm-wiki`, or any other sibling repo. Reusable as a starting point for any agent with persistent state.
- **TypeScript, Node 24, ESM.** Same toolchain family as `aws-cloud-agent`.
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
┌──────────────────┐                    │   │  1. hydrate DB      │   │
│ Discord webhook  │ ◄────── POST ──────┤   │  2. fetch external  │   │
│ (user-supplied)  │                    │   │  3. dedup vs state  │   │
└──────────────────┘                    │   │  4. post to Discord │   │
                                       │   │  5. upload new DB   │   │
┌──────────────────┐                    │   │     (If-Match)      │   │
│ HTTP client      │  {op:"status"}     │   └─────────────────────┘   │
│ (curl, browser)  ├───────────────────►│   ┌─────────────────────┐   │
└──────────────────┘                    │   │ op = "status"       │   │
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
                                       └─────────────┼───────────────┘
                                                     ▼
                                       ┌─────────────────────────────┐
                                       │ s3://<bucket>/memory.db     │
                                       │ (versioned, single object)  │
                                       └─────────────────────────────┘
```

**One function, two ops.** The Lambda reads `op` from the event payload (EventBridge → `fetch`, Function URL → `status`). The container image and role are identical.

**`fetch` is the writer; `status` is the reader.** Both share `/tmp/memory.db`. The reader's job is to make the writer's state visible — without it, the only way to inspect the bot is `aws s3 cp` and `sqlite3`, which is bad tutorial UX. The reader is a JSON endpoint, not a UI: callers (`curl`, `aws lambda invoke`, browser address bar) see `sources[]` and `recentNotifications[]`, not a dashboard.

**Single-writer invariant.** The function has `reservedConcurrency: 1`. Without it, two simultaneous `fetch` invocations could both hydrate the same version, both upload, and silently overwrite each other's writes. The `status` op is read-only by IAM (`s3:GetObject` only, no `s3:PutObject`), so the writer's state is safe even though it shares the role.

---

## 3. Data flow

### 3.1 `fetch` op (the writer)

```
1.  S3 GetObject on s3://<bucket>/memory.db
    - 404 → bootstrap branch (§4.1)
    - 200 → /tmp/memory.db, capture ETag
2.  better-sqlite3 open /tmp/memory.db (WAL, immutable=false)
3.  bootstrap() — CREATE TABLE IF NOT EXISTS sources, notifications, runs (§5)
4.  BEGIN; INSERT agent_runs (run_id, op='fetch', snapshot_version_in, started_at); COMMIT
5.  For each configured source (e.g. weather, crypto):
    a. Fetch external value (HTTPS GET via SourceFetcher)
    b. Read sources.last_value for this source
    c. If new value == last_value, skip (no Discord post, no notification row)
    d. Else: format message; POST to Discord webhook; on 2xx, INSERT notification;
       UPDATE sources SET last_value = ?, last_posted_at = ?
6.  UPDATE agent_runs SET ended_at, outcome, sources_checked, notifications_sent, error
7.  S3 PutObject to s3://<bucket>/memory.db with If-Match: <ETag>
    - 412 PreconditionFailed → log, abort, leave old version authoritative
8.  close()
```

### 3.2 `status` op (the reader)

```
1.  HEAD on s3://<bucket>/memory.db; capture ETag
2.  If module-scope cached ETag equals current and /tmp/memory.db exists:
    reuse, open read-only handle
3.  Else: close any open handle, rm /tmp/memory.db, GetObject → /tmp/memory.db,
   cache ETag, open read-only handle
4.  Query: SELECT name, last_value, last_fetched_at, last_posted_at FROM agent_sources
           + last N rows from agent_notifications JOIN agent_sources
5.  Return JSON: { snapshotVersion, sources: [...], recentNotifications: [...] }
```

The version cache (§4.3) is what makes warm invocations cheap. `setup()` here is just opening a SQLite file, so the payoff is smaller than `aws-cloud-agent`'s MiniSearch rebuild — but the *mechanism* is the same, and the tutorial teaches it.

---

## 4. Rehydration protocol

Three mechanisms, each teaching one part of the pattern.

### 4.1 Bootstrap (writer's first run)

When `S3.GetObject` returns `NoSuchKey`:

1. Open `/tmp/memory.db` with `better-sqlite3`. Empty file.
2. Run `bootstrap()`: create the three tables (§5). Idempotent.
3. Capture ETag as a sentinel `*` for the conditional write (4.2).
4. Continue the normal write flow.

On subsequent runs, `S3.GetObject` returns 200 and bootstrap is skipped. The branch exists to make `npm run deploy` succeed on day one without a manual `aws s3 cp` step.

### 4.2 Conditional write (writer's PUT)

The writer's `PUT` uses `If-Match: <ETag>` captured during `GetObject`:

- **200 OK** → success. Capture the new ETag for the run record.
- **412 Precondition Failed** → another writer committed while this one worked. **Abort loudly, do not retry.** A blind retry would re-fetch from the external API and re-post to Discord against a stale base. Since `reservedConcurrency: 1` makes this race impossible, 412 means a misconfiguration or an out-of-band write — either way, fail is the correct response.
- **Bootstrap case** → the bootstrap branch omits `IfMatch` entirely; S3 treats it as a fresh put. The `*` sentinel only governs the *caching* of "no prior version," not the wire format.

### 4.3 Version-cached read (reader's hydration)

The reader keeps the last hydrated ETag in module scope. Each invocation:

1. `HEAD s3://<bucket>/memory.db`. Capture current ETag.
2. If module-scope ETag equals current ETag and `/tmp/memory.db` exists: open a read-only handle to the existing file.
3. Else: close any open handle, `rm /tmp/memory.db`, `GetObject` → `/tmp/memory.db`, open a read-only handle, update module-scope ETag.

**Why close-and-reopen rather than reuse the open handle?** `better-sqlite3` keeps a page cache in memory. If the file on disk changes underneath an open handle, the cache describes a file that no longer exists — silently wrong answers, no error. The mechanism is the same one `aws-cloud-agent` uses for the same reason.

The version cache is what makes warm reader invocations cheap. On a warm Lambda, an unchanged DB costs a `HEAD` and a query. A cold Lambda or a new snapshot pays one `GetObject` and one handle open. This is the headline benefit of the pattern; the tutorial teaches it explicitly.

---

## 5. Schema

Three tables, prefixed `agent_` (matching `aws-cloud-agent`'s convention) so future migrations stay collision-free.

```sql
CREATE TABLE agent_sources (
  name              TEXT PRIMARY KEY,
  last_value        TEXT,
  last_fetched_at   INTEGER,                    -- unix ms
  last_posted_at    INTEGER,                    -- unix ms; null if never posted
  CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto'))
);

CREATE TABLE agent_notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  posted_at   INTEGER NOT NULL,
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

**`outcome` and `error` are nullable on purpose.** A run row inserted at step 4 of the writer lifecycle (§3.1) and never updated is itself a record: "this run started and never finished." That signal is lost if the columns default to a fake value. Same pattern as `aws-cloud-agent`'s `agent_runs`.

**`source` is a closed vocabulary.** `weather` and `crypto` only. The tutorial is intentionally narrow — readers extend it by editing one CHECK constraint and one fetch function, not by designing a registry. The constraint prevents typos like `wether` from silently producing empty dedup state.

---

## 6. Error handling

Categorised, with the right response for each. The reader of the tutorial should be able to map every AWS error class to a clear "what happens" without reading code.

| Failure | Where it surfaces | What we do |
|---|---|---|
| External API 4xx/5xx or timeout | per-source fetch | Skip that source. Append a description to `agent_runs.error`. Continue with other sources. The run completes its loop and ends with `outcome = 'success'`; the per-source failures live in the `error` column. |
| Discord webhook 4xx | per-source post | Skip the `sources.last_posted_at` update and the `agent_notifications` insert for that source. The next run will retry. Append to `agent_runs.error`. |
| Discord webhook 5xx | per-source post | Same as 4xx, but a single retry within the invocation (one retry, ~250ms backoff). Two failures → skip the source for this run. Append to `agent_runs.error`. |
| S3 conditional write 412 | step 7 of `fetch` | **Abort loudly.** Do not retry, do not upload, do not update the local DB further. The previous snapshot stays authoritative. Update the in-progress `agent_runs` row with `outcome = 'error'` and a description of the 412, then propagate. EventBridge retries on invocation failure are disabled for this op — the failure is informational, not transient. |
| S3 `GetObject` 5xx (not 404) | step 1 of `fetch` | Bubble up. Lambda marks invocation failed. EventBridge retries with backoff. No `agent_runs` row is written (we never got far enough). |
| Bootstrap error (S3 403, IAM) | step 1 of `fetch` | Bubble up. Clear configuration error, surfaced in CloudWatch. |
| SQLite open / DDL error | step 2-3 of `fetch` | Bubble up. Previous snapshot is untouched. |
| Reader cache stale (version changed) | step 3 of `status` | Close existing handle, re-download. Idempotent. |

**`outcome = 'error'` is reserved for failures that abort the whole run after step 4** (i.e., after the `agent_runs` row has been inserted). Per-source failures inside the loop set `outcome = 'success'` and append to `agent_runs.error`; the run still completes its loop. Failures before step 4 bubble up and leave no `agent_runs` row — they appear in CloudWatch only.

**The principle: every error category has exactly one right answer, and it's the same answer every time.** `aws-cloud-agent`'s design calls this out explicitly in its §6 prose; the tutorial does the same because it teaches a habit, not just a pattern.

**`agent_runs.error` is one column, plural messages concatenated.** Per-source failures inside a multi-source run are joined with `; `. The tutorial teaches "one column per log line" rather than a sidecar table, because the table is a tutorial artefact, not a query surface.

---

## 7. Testing

Tests run against a **real SQLite file** with a real `better-sqlite3` handle — no mocks of the database. `aws-cloud-agent`'s design calls this out explicitly ("the library's actual behaviour is the thing under test") and the tutorial adopts the same principle. Network boundaries are mocked because Discord and external APIs are out of our control.

### 7.1 What we mock, what we don't

| Boundary | Mocked? | How |
|---|---|---|
| `better-sqlite3` | No | Real SQLite file in `/tmp` per test. |
| S3 client | Yes | `aws-sdk-client-mock` (matches `aws-cloud-agent`). |
| Discord webhook | Yes | A `DiscordPoster` interface; production = real `fetch`, tests = in-memory recorder. |
| External value API | Yes | A `SourceFetcher` interface keyed by source name; production = real `fetch`, tests = returns canned values. |

### 7.2 Trap guards

- **Bootstrap is idempotent.** Run `bootstrap()` on an empty DB twice; assert no schema errors, no data loss.
- **Dedup is correct.** Insert `agent_sources` row with `last_value = '72F'`. Run the writer with a new fetch returning `'72F'`. Assert no `agent_notifications` row inserted and no `last_posted_at` change.
- **Dedup on real change.** Same setup, new fetch returns `'73F'`. Assert exactly one `agent_notifications` row, `last_value = '73F'`, `last_posted_at` updated.
- **Partial-source failure doesn't poison the run.** Mock weather fetch to throw, crypto fetch to succeed. Assert the run row records the error, the notification is inserted, and the run outcome is `success`.
- **Conditional write 412 is honored.** Mock S3 to return 412 on `PutObject`. Assert no upload occurred and the previous version is untouched (verified by reading the local DB before the abort).
- **Reader cache invalidation.** Set cached ETag to a value different from current. Assert a fresh `GetObject` happens. Set them equal; assert no `GetObject` happens.
- **Closed vocabulary.** Insert `agent_sources(name = 'wether')` and assert CHECK constraint failure.

### 7.3 Smoke test

`scripts/smoke.sh` invokes the deployed `fetch` op, waits for the run, then invokes `status` and asserts the JSON contains a `weather` source with a `lastValue`. Matches `aws-cloud-agent`'s smoke pattern; tutorial readers can run it after deploy to verify end-to-end.

---

## 8. Out of scope

Deliberate. Not built, even where it appears to be the natural next step.

- **A web dashboard.** The reader is a JSON endpoint (§2). A dashboard is a separate tutorial.
- **Multi-tenancy, multiple Discord channels.** The tutorial targets one webhook. Configuration extension is left to the reader.
- **Vector search, embeddings, semantic dedup.** Dedup is byte-for-byte equality on the source value. If "weather changed from 72F to 72.0F" should count as a change, that's a future tutorial's problem.
- **LLM extraction, summarisation, "AI" anything.** The bot posts raw values. The point of the tutorial is the SQLite/S3 pattern, not the bot's intelligence.
- **A `social` retrieval profile, episodic tiers, ontology, outbox.** All `aws-cloud-agent`-specific concepts, all intentionally omitted.
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
| **1 — Local** | SQLite schema + `bootstrap()` + dedup logic + an in-memory `DiscordPoster` and `SourceFetcher`. A CLI script (`npm run local-fetch`) runs the writer end-to-end against `/tmp/memory.db`. No AWS. | Run the script; assert the DB has the right rows. Run `npm test`. |
| **2 — S3 rehydration** | `S3Store` class: `get`, `put` (with `If-Match`), `head`. Bootstrap branch. Conditional write. Real S3 (or LocalStack) behind a config flag. | `npm run local-fetch -- --s3` hydrates from S3, runs, uploads; `npm run s3-fetch` does the same against a real bucket. |
| **3 — Lambda** | Container image, CDK stack, EventBridge schedule, Function URL. Reserved concurrency 1. Single IAM role scoped to the one bucket. `scripts/deploy.sh`. | `npm run deploy`; `aws lambda invoke` against the deployed function for both ops; `scripts/smoke.sh` end-to-end. |
| **4 — Reader + run logs** | `status` op, version cache, `agent_runs` populated on every invocation. `scripts/smoke.sh` extended to query status. | `curl <function-url> --data '{"op":"status"}'` returns the expected JSON. |

The CDK deploy is in phase 3, not phase 1, because tutorial readers should be able to see the local behaviour before CDK enters the picture. Splitting phases this way also means `npm run deploy` is the *last* thing a reader does, not the first — which is the right order for understanding.

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
│   └── 05-from-tutorial-to-prod.md  # the deltas vs aws-cloud-agent
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
│   └── bootstrap.test.ts
├── Dockerfile                       # arm64 cross-compile block (§8.5 of aws-cloud-agent)
├── package.json
├── tsconfig.json
├── tsconfig.check.json
└── vitest.config.ts
```

`docs/01-architecture.md` is the tutorial's *narrative*. The code is the working example; the docs explain why each piece exists. `docs/05-from-tutorial-to-prod.md` is a closing piece that points at `aws-cloud-agent` for readers who outgrow the tutorial — making the lineage explicit.

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

reservedConcurrency           default 1
```

Two things are deliberately *not* in here.

**The AWS CLI profile.** `llm-wiki-admin` (or whatever profile the reader uses) is a deployment-time concern, read from `AWS_PROFILE` by `scripts/deploy.sh`. A Lambda has an execution role, not a CLI profile; putting it in the runtime config would imply the running system could use it.

**The external API keys.** Weather and crypto APIs that need keys should read them from their own env vars at fetch time, not from a global config. The tutorial will use key-free public endpoints (`wttr.in`, `coingecko`) for the demo; readers plugging in a paid API extend the fetcher interface, not the config.

**What the config validates, it validates at load.** `snapshotBucket` throws when absent rather than defaulting; `sources` rejects anything outside the closed vocabulary; numeric variables that don't parse throw naming themselves. Each of these turns what would otherwise be an opaque runtime failure into a startup error that says what to fix.
