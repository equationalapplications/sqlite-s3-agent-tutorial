# Composable agents

A **lightweight, composable cloud agent** is a thing that spins up, does a few minutes —
or a few seconds — of work, and goes away. No process stays resident. No state is held in
memory between runs. Whatever has to outlive one run gets written down somewhere durable
before the agent exits.

You already built one. The `fetch` tick in this repo *is* an agent of exactly that shape,
and the rest of this page is a ladder: rung 1 is the thing you have, and each rung above
it is one step toward the fuller shape this pattern takes when there is more than one
agent and more than one job.

Only rung 1 is implemented here. Everything from rung 2 up is conceptual — no code, no
tables, and no infrastructure in this repo correspond to it. Each rung says so, and points
at the existing doc that already holds the piece a real implementation would start from.

## Rung 1: the fetch tick is already one

Nothing new is introduced at this rung. It is the same system described in
[docs/01-architecture.md](01-architecture.md), renamed in the vocabulary the rest of this
page uses.

**Heartbeat.** The EventBridge 5-minute schedule, whose `Input` is the literal string
`{"op":"fetch"}`. Something outside the agent decides when it runs; the agent itself has
no timer, no loop, and no opinion about the clock.

**Spin up, work, go away.** One Lambda invocation is the entire lifetime: hydrate the
SQLite file from S3, call Bedrock twice, post to Discord, conditional-write the file back,
exit. There is no "between" for the agent to exist in.

**Statelessness between runs.** Careful here, because the honest version is more
interesting than the slogan. `/tmp` is not wiped between invocations — warm containers
reuse it, and this repo leans on that: the status reader keeps a cached database handle
across invocations precisely because `/tmp` persists, and
[docs/02-rehydration.md](02-rehydration.md) notes it survives until a redeploy. The
guarantee is not that `/tmp` is empty. The guarantee is that **correctness never depends
on what is in it.** Everything that must outlive an invocation lives in the S3 object; the
local file is a cache that a cold start is free to throw away.

**Why "composable."** Because no state is carried in the agent process, there is nothing
to coordinate except the storage. Any number of these can exist — different schedules,
different triggers, different jobs — provided they agree on the storage contract. This
repo's contract is the conditional write on the S3 object, guarded by
`reservedConcurrentExecutions: 1` and described in
[docs/10-concurrency.md](10-concurrency.md). That contract, not any shared runtime, is
what makes a second agent possible.

This is the load-bearing rung. "Lightweight cloud agent" is not an abstraction being
introduced — it is a name for the thing already running on your schedule.
