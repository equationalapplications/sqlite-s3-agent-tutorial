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
`null` means "this is a fresh put, fail if the key already exists." `S3Store` translates
that to an `If-None-Match: "*"` conditional create on the wire, not an unconditioned
overwrite: if a concurrent deployment or `aws s3 cp` has materialized the object since
this invocation started, S3 rejects the PUT with a 409 and the writer surfaces the same
loud failure a 412 would. That keeps S3's HTTP semantics contained inside `S3Store`; the
writer's orchestration code never sees a header, just a `string | null`.

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

## 4. `/tmp` storage ceiling

The hydration pattern depends on a local file at `/tmp/memory.db`, which lives on
Lambda's ephemeral local storage — not on S3 and not on any volume that persists across
invocations. That storage has a hard ceiling:

- **Default:** 512 MB. `/tmp` is provisioned at this size unless you override it.
- **AWS maximum:** 10,240 MB (10 GB), set via the `ephemeralStorage` prop on
  `aws-cdk-lib/aws-lambda`'s `DockerImageFunction`. `infra/stack.ts` does not override
  the default, so a fresh deploy runs at 512 MB.

A snapshot row plus its embedding is roughly 4 KB on disk. 512 MB holds about 131,000
ticks' worth of rows — enough that the file still fits in `/tmp` after about 450 days
of running the 5-minute loop (`npm run loop-start`, 288 ticks/day — see the README's Loop
mode section). Past that, `s3.GetObject` fails with `No space left on device` on the
next hydrate and the writer publishes nothing until a redeploy resurfaces a fresh
container with an empty `/tmp`.

If you intend to leave the loop running unattended for longer than that, set
`ephemeralStorage: Size.gibibytes(10)` on `agentFunction` in `infra/stack.ts` and
redeploy. At the AWS cap the same math gives roughly 2.6 million ticks of headroom —
about 25 years at 5-minute cadence. The RAG corpus (`agent_notifications` +
`agent_embeddings`) is the dominant growth term; status reads and `agent_runs` rows are
small by comparison.

## Bedrock setup

Before the first `fetch` invocation can succeed, the deploying account in `us-east-1` needs
two things: an active AWS Marketplace subscription for the configured `bedrockModelId`
(default `zai.glm-4.7-flash`), and an IAM policy that grants `bedrock:InvokeModel` against
it. Bedrock enables foundation-model access by default in commercial Regions once the
Marketplace subscription is in place — the legacy manual *Bedrock → Model access* console
flow is no longer the gating step for this model. If you point `bedrockModelId` at an
Anthropic model instead, Bedrock requires a separate first-time-use EULA acceptance on the
same page before that model will invoke; that step *is* still a manual console action and
is the one remaining reason to open the *Model access* screen.

The CDK stack's IAM policy is generated at synth time from the configured model's family
(see `src/format/families.ts`) and is permissive enough to invoke the chosen model — but a
Marketplace subscription must already exist on the account, or `bedrock:InvokeModel`
returns `AccessDeniedException` regardless of what the IAM policy says. `cdk deploy` does
not check for the subscription, so the stack deploys cleanly and the first `fetch` fails —
which is why this tutorial calls it out before the first deploy rather than after.

For Discord webhook setup, see [docs/06-discord-webhook-setup.md](06-discord-webhook-setup.md).
