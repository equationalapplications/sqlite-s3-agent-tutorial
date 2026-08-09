# Concurrency: optimistic S3 rehydration

SQLite-rehydrated-from-S3 is not a database server, and it does not pretend to be one.
S3 has no partial file locking, so SQLite's own concurrency machinery — `WAL` mode,
`BEGIN IMMEDIATE`, POSIX advisory locks — is entirely blind to a second Lambda execution
container holding its own copy of the same file in `/tmp`. Whatever safety this pattern
has comes from one place: the conditional write back to S3.

That's enough to be safe, and it is a well-worn pattern rather than a local invention.
It is *optimistic concurrency control* (OCC) — the same compare-and-swap discipline
relational databases use for row versions — applied to a whole database file, and it
became practical for S3 the day AWS shipped conditional writes. See Simon Willison's
[write-up of S3 conditional writes](https://simonwillison.net/2024/Nov/26/s3-conditional-writes/)
and Chris King's
["Why I Built a Distributed SQLite on S3"](https://dev.to/chris_king_bcff3b9663e84a/why-i-built-a-distributed-sqlite-on-s3-and-why-you-might-care-3h9h)
for the wider context.

## The topology: master and sub-copies

S3 holds the master. Each Lambda's `/tmp` holds a short-lived, disposable sub-copy. The
ETag is the version token that ties a sub-copy back to the master revision it came from.

```
 ┌────────────────────────────────────────────────────────┐
 │                    Amazon S3 (MASTER)                  │
 │              [ agent.db ]        ETag: "xyz123"        │
 └───────────────────────────┬────────────────────────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼ (download sub-copy)             ▼ (download sub-copy)
┌───────────────────────┐         ┌───────────────────────┐
│ Lambda Worker A       │         │ Lambda Worker B       │
│ Local: /tmp/agent.db  │         │ Local: /tmp/agent.db  │
│ Base ETag: "xyz123"   │         │ Base ETag: "xyz123"   │
└───────────┬───────────┘         └───────────┬───────────┘
            │ (mutates state)                 │ (mutates state)
            ▼                                 ▼
   [ wins & uploads ]                [ loses & aborts ]
   PutObject with                    PutObject with
   If-Match: "xyz123"                If-Match: "xyz123"
   (accepted; ETag advances)         (rejected: 412 Precondition Failed)
```

### The lifecycle

1. **Hydrate.** The tick downloads the snapshot from S3 and keeps its ETag.
2. **Work locally.** All reads and writes happen against the sub-copy in `/tmp`.
3. **Compare-and-swap.** The upload is a `PutObject` carrying `If-Match: <original ETag>`.
   On a bootstrap write — no object yet — it carries `If-None-Match: "*"` instead.
4. **Resolve the collision.** If nobody else wrote, the ETag still matches, S3 commits,
   and the master advances. If a concurrent writer got there first, the master ETag has
   already moved and S3 answers `412 Precondition Failed`.

The important property is what *doesn't* happen: the loser never overwrites the winner.
There is no silent lost update. The failure is loud and it is on the losing side.

## What this repo actually does with a 412

The tutorial implements steps 1–4 (`src/store/s3.ts`, `src/agent/fetch.ts`) but stops
short of the last move in the classic pattern — **rebase and retry**. A
`PreconditionFailedError` is treated as an abort, not a retryable tick-level failure: the
run row is marked `outcome='error'` in the local copy, the exception propagates, and the
tick is abandoned. The next scheduled tick starts clean from whatever the master now is.

Two consequences worth being explicit about:

- **The losing tick's database work is discarded.** That is the intended trade — losing a
  tick's rows is cheap, and a snapshot-wide "merge" would mean reconciling arbitrary
  SQL side effects.
- **Side effects already performed are not discarded.** By the time the publish is
  attempted, the tick has already called Bedrock and already posted to Discord. A 412
  therefore means: message delivered, database state rolled back. On the fixed 5-minute
  schedule with `reservedConcurrentExecutions: 1`, this doesn't happen — it becomes
  reachable once a manual trigger can race the scheduled loop.

If you add write paths, either serialize them ahead of the write or move the side effects
after a successful publish. Reserved concurrency only serializes invocations of *one*
function; it does nothing about two different functions writing the same key.

## Adding rebase-and-retry

The natural next step, and the one the pattern normally includes: catch the 412,
re-download the now-current master, replay the tick's *inputs* against the fresh
sub-copy, and publish again with the new ETag. Bound the attempts and back off between
them.

This works well when the tick's work is a pure function of freshly fetched data — which
is close to true here — and badly when replaying means re-running expensive or externally
visible steps. That is the real reason to hoist the Bedrock call and the Discord post out
of the retryable region before adding retries.

## High contention: the single-writer queue

Retry loops degrade under load. With enough concurrent writers, every attempt invalidates
someone else's ETag and the fleet spends its time thrashing instead of committing —
progress goes down as concurrency goes up. Past a handful of writers, stop contending and
serialize instead.

```
┌─────────────────┐
│ Lambda Agent 1  │ ──┐
└─────────────────┘   │ (write requests)
┌─────────────────┐   ▼       ┌───────────────────┐        ┌───────────────────────┐
│ Lambda Agent 2  │ ────────> │ Amazon SQS Queue  │ ─────> │ SINGLE-WRITER LAMBDA  │
└─────────────────┘   ▲       └───────────────────┘        │ reserved concurrency 1│
┌─────────────────┐   │                                    └───────────┬───────────┘
│ Lambda Agent 3  │ ──┘                                                │ (exclusive)
└─────────────────┘                                                    ▼
                                                           ┌───────────────────────┐
                                                           │   Amazon S3 (master)  │
                                                           └───────────────────────┘
```

1. **Make the agents read-only.** They hydrate sub-copies and query them; they never
   `PutObject`.
2. **Send writes as messages.** A new fact, a log row, an embedding — serialize the
   intent and push it to SQS instead of pushing bytes to S3.
3. **Pin one coordinator.** A separate Lambda with maximum concurrency set to 1 is the
   only thing that touches the master.
4. **Batch.** The coordinator drains a batch, downloads the snapshot once, applies every
   transaction in one pass, and uploads once.

Collisions become structurally impossible rather than merely detected, and the S3 write
rate drops to one per batch instead of one per agent. The cost is latency — writes are
now asynchronous — plus the usual SQS concerns: ordering is only per-message-group with a
FIFO queue, and at-least-once delivery means the coordinator's apply step must be
idempotent.

## When to stop doing this at all

If you need concurrent writers with transactional consistency across agents, this pattern
is the wrong shape and no amount of tuning fixes it. See
[05-from-tutorial-to-prod.md](05-from-tutorial-to-prod.md) for the exits: Litestream for
long-running containers, Aurora Serverless v2 or DynamoDB for relational state, and
OpenSearch Serverless or pgvector for the embeddings.

One trap worth naming, because it looks like an easy win: **EFS is not a multi-writer
substitute.** Mounting EFS at `/mnt/storage` removes the per-invocation download, but EFS
offers NFSv4 advisory locking only, and SQLite's `WAL` mode needs POSIX shared memory
that no network filesystem provides. Concurrent writers across Lambda hosts risk
`database is locked` and, in failure cases, corruption. EFS changes where the file lives;
it does not change how many writers SQLite can safely have.
