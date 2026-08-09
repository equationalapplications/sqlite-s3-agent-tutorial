# Architecture

One Lambda function. Two operations, read as `event.op`: `fetch` (the writer, run daily by
EventBridge) and `status` (the reader, exposed by a Function URL). Both read and write the
same single SQLite file that lives durably in one S3 object, but each keeps its own
transient copy in `/tmp` for the lifetime of the execution environment: the writer at
`${DB_PATH}` (default `/tmp/memory.db`), the reader at `${DB_PATH}.reader` (default
`/tmp/memory.db.reader`). Warm Lambda invocations share that `/tmp`, which is exactly what
lets the status reader reuse its cached database handle (see
[docs/02-rehydration.md](02-rehydration.md)); cold starts discard it and rehydrate from S3.

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

A more ambitious agent might split the reader into its own Lambda — say, when the reader
also runs semantic search backed by a vector index that needs its own warm-container
lifecycle tuning. This tutorial's reader is a much smaller job: query two tables and
return JSON. Splitting it into a second Lambda would mean a second container image, a
second set of IAM grants, and a second cold-start budget — for a query that returns in
single-digit milliseconds once hydrated. One function with an `op` field is simpler and
the tutorial's job is to teach the storage pattern, not Lambda topology.

## The single-writer invariant

The function is deployed with `reservedConcurrentExecutions: 1`. Without it, two
overlapping `fetch` invocations could both hydrate the same S3 version, both do their
work, and both try to publish — the second one either overwrites the first's notification
silently (if writes aren't conditional) or gets rejected with a 412 (because they are).
Reserved concurrency 1 means only one invocation of this function runs at a time, so that
race can't happen at all. The conditional write is a second line of defense that also
protects against an out-of-band `aws s3 cp` — belt and suspenders.

## Bedrock calls: formatting and embedding

Between the value fetch and the Discord post, the writer calls Amazon Bedrock's Converse
API to turn the raw value into a friendly message, and a second, smaller Bedrock round
trip — Titan Text Embeddings V2, via `InvokeModel` rather than `Converse` — embeds each
posted notification into a `sqlite-vec` table inside the same `memory.db` file, so the
writer can mention the closest same-source past result in the prompt above; see
[docs/08-rag-vector-search.md](08-rag-vector-search.md).

## EventBridge's payload

The schedule's `Input` is the literal string `{"op":"fetch"}`, not a transformed event.
EventBridge's own invocation envelope (the `detail`, `time`, `resources` fields it
normally wraps a target's input in) is not something the handler ever has to know about —
it reads `event.op` directly. A transformed input would produce the same behavior, but a
constant one is unambiguous and doesn't depend on how EventBridge's wrapper shape might
change.
