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

## Rung 2: a to-do list instead of one fixed job

> **Not implemented in this repo.** Conceptual from here on.

Today the job is hardcoded: every heartbeat does the same fetch, because the fetch *is*
the schedule's payload. An agent that only ever does one thing does not need to be told
what to do.

The first generalization is to stop hardcoding it. Give the agent a **to-do list** — a
table of pending work items, each with enough to decide whether it is due — and the loop
becomes: wake on heartbeat, read the list, decide what is due, act. The heartbeat stops
meaning "do the fetch" and starts meaning "check whether there is anything to do."

The natural home for that table is the same SQLite file the agent already hydrates, which
keeps the one-file philosophy from [docs/01-architecture.md](01-architecture.md) intact —
the work queue and the work product live in the same object, committed by the same
conditional write. Nothing new has to exist for this rung; it is a table and a `WHERE`
clause.

At this rung the agent that reads the list is also the agent that does the work. That is
the constraint rung 3 removes.

## Rung 3: delegation and hierarchy

> **Not implemented in this repo.**

Instead of doing a to-do item itself, the agent invokes another Lambda scoped to that one
item, and moves on. The first agent becomes an **orchestrator**: its job is deciding what
runs, not running it. The invoked one is a **sub-agent**.

This is recursive, not one level of fan-out. A sub-agent handed "summarize this week's
readings" can decide that is still too big, split it into seven days, and invoke seven
sub-agents of its own. Depth is a property of the work, not of the topology.

The forcing constraint is Lambda's roughly 15-minute runtime ceiling. Any unit of work
that might exceed it cannot be done inline — it has to be decomposable into pieces that
each fit, or moved off Lambda entirely (rung 5). Delegation is not primarily an elegance
argument; it is how work outgrows a single invocation without outgrowing the platform.

One thing delegation does **not** change: the single-writer invariant from
[docs/10-concurrency.md](10-concurrency.md). Fanning out multiplies *invocations*, not
*writers*. Sub-agents do not each get their own conditional write to the shared S3 object
— thirty agents contending on one ETag is the failure mode that doc describes, not a
design. Where their results actually go is rung 4.
