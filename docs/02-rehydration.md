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

Instead, the reader's state lives in a closure returned by `createStatusReader` — that
closure holds the last snapshot's S3 ETag and the open read-only SQLite handle.
`src/handler.ts` keeps a module-scope `Map<dbPath, StatusReader>` and looks up (or creates)
one entry per `dbPath`. Because Lambda doesn't re-run module-level code on every invoke —
only on cold starts — the Map, and therefore the reader instance it points at, survive
warm invocations. Each request does a cheap `HEAD` first. If the returned ETag matches
what's cached and the local file still exists, the reader reuses its already-open SQLite
handle. Only when the ETag differs does it close the old handle, delete the stale local
file, download the new one, and open a fresh handle.

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
