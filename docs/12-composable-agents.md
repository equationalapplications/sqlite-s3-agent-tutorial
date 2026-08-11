# Composable agents

A **lightweight, composable cloud agent** spins up, works for a few minutes — or a few
seconds — and goes away. No process stays resident. The agent carries no state in memory
that has to outlive an invocation; whatever has to outlive one run gets written down
somewhere durable before the agent exits.

You already built one. The `fetch` tick in this repo *is* an agent of exactly that shape,
and the rest of this page is a ladder: rung 1 is the thing you have, and each rung above it
is one step toward the fuller shape this pattern takes with more agents and more jobs.

Only rung 1 is implemented here. Everything from rung 2 up is conceptual — no code,
tables, or infrastructure in this repo correspond to it — and each rung points at the
existing doc holding the piece a real implementation would start from.

## Rung 1: the fetch tick is already one

Nothing new is introduced at this rung. It is the same system described in
[docs/01-architecture.md](01-architecture.md), renamed in the vocabulary the rest of this
page uses.

**Heartbeat.** The EventBridge 5-minute schedule, whose `Input` is the literal string
`{"op":"fetch"}`. Something outside the agent decides when it runs; the agent itself has
no timer, no loop, and no opinion about the clock.

**Spin up, work, go away.** One Lambda invocation is the entire lifetime: hydrate the
SQLite file from S3, do the agent's scoped work, conditional-write the file back, exit.
There is no "between" for the agent to exist in.

**Statelessness between runs.** The honest version is more interesting than the slogan.
`/tmp` is not wiped between invocations — warm containers reuse it, and this repo leans on
that: the status reader keeps a cached database handle precisely because `/tmp` persists,
and [docs/02-rehydration.md](02-rehydration.md) notes it survives until a redeploy. The
guarantee is not that `/tmp` is empty; it is that **correctness never depends on what is
in it.** Everything that must outlive an invocation lives in the S3 object, and the local
file is a cache a cold start is free to throw away.

**Why "composable."** Because no durable state is carried in the agent process, there is
nothing to coordinate except the storage. The conditional write on the S3 object described
in [docs/10-concurrency.md](10-concurrency.md) is what makes a second agent possible —
without it, two invocations landing at once would silently clobber each other.

That protection is scoped to the S3 object. The conditional write stops the file from
being corrupted; it does not serialize separate Lambda functions, and any side-effecting
operations the agent performs before the write — outbound notifications, downstream API
calls — are not made idempotent by it. Two agents running the same job at once can still
fire those side effects twice before either write commits. That is the duplicate-side-
effect hazard rung 4's queue exists to eliminate.

This repo's `reservedConcurrentExecutions: 1` is the tutorial default, function-scoped and
overridable via `RESERVED_CONCURRENCY`. It is a second line of defense, not a general
multi-agent coordination primitive.

This is the load-bearing rung. "Lightweight cloud agent" is not an abstraction being
introduced — it is a name for the thing already running on your schedule.

## Rung 2: a to-do list instead of one fixed job

> **Not implemented in this repo.** Conceptual from here on.

Today the job is hardcoded: every heartbeat does the same fetch, because the fetch *is* the
schedule's payload. An agent that only ever does one thing needs no instructions.

The first generalization is to stop hardcoding it. Give the agent a **to-do list** — a
table of pending work items, each with enough to decide whether it is due — and the loop
becomes: wake on heartbeat, read the list, decide what is due, act. The heartbeat stops
meaning "do the fetch" and starts meaning "check whether there is anything to do."

The natural home for that table is the same SQLite file the agent already hydrates, which
keeps the one-file philosophy from [docs/01-architecture.md](01-architecture.md) intact —
the work queue and the work product live in the same object, committed by the same
conditional write. Nothing new has to exist for this rung; it is a table and a `WHERE`
clause. The agent that reads the list is still the agent that does the work — the
constraint rung 3 removes.

## Rung 3: delegation and hierarchy

> **Not implemented in this repo.**

Instead of doing a to-do item itself, the agent invokes another Lambda scoped to that one
item, and moves on. The first agent becomes an **orchestrator**: its job is deciding what
runs, not running it. The invoked one is a **sub-agent**.

This is recursive, not one level of fan-out. A sub-agent handed "summarize this week's
readings" can split it into seven days and invoke seven sub-agents of its own. Depth is a
property of the work, not of the topology.

The forcing constraint is Lambda's roughly 15-minute runtime ceiling. Any unit of work
that might exceed it cannot be done inline — it has to be decomposable into pieces that
each fit, or moved off Lambda entirely (rung 5). Delegation is not primarily an elegance
argument; it is how work outgrows a single invocation without outgrowing the platform.

One thing delegation does **not** change: the single-writer invariant from
[docs/10-concurrency.md](10-concurrency.md). Fanning out multiplies *invocations*, not
*writers*. Sub-agents do not each get their own conditional write — a fleet contending on
one ETag is that doc's failure mode, not a design. Rung 4 is where their results go.

## Rung 4: intents through a queue, not direct writes

> **Not implemented in this repo.**

Once there is a hierarchy, the question rung 3 deferred comes due: how do a dozen
sub-agents get their results into one S3 object? Not by each conditional-writing it. That
is the contention problem — every attempt invalidating someone else's ETag until the fleet
thrashes instead of committing — and
[docs/10-concurrency.md](10-concurrency.md#high-contention-the-single-writer-queue)
already diagrams the answer.

Reuse it exactly as written. Sub-agents become read-only: they hydrate sub-copies, do
their scoped work, and emit an **intent** — a message describing what changed, not a
rewritten file — onto a queue. One pinned coordinator, concurrency 1, drains the queue in
batches and is the only thing that touches the master object. Collisions stop being
detected and start being impossible, and the S3 write rate drops to one per batch rather
than one per agent. The costs are the ones that doc already names: writes become
asynchronous, and at-least-once delivery means the apply step has to be idempotent.

This rung also gives the master object a name it will need later. Seen from inside the
hierarchy, it is the **central memory**: the one shared thing every agent's intents land
in, and the only place the system's state is authoritative. Rung 6 is about its shape.

## Rung 5: follow-up tasks and the EC2 escape hatch

> **Not implemented in this repo.**

Two things would break the ladder if left unaddressed, and both are answered by pieces
already on it.

**Work that doesn't finish.** A sub-agent approaching its timeout does not retry-loop
inside Lambda, and does not silently drop what it was doing. It emits an **intent**
describing a **follow-up item** for the to-do list from rung 2 — "resume from here" —
and exits cleanly. The coordinator applies the intent on its next drain, the follow-up
shows up in the to-do list like any other item, and the orchestrator picks it up on a
later heartbeat. Progress is durable because it was written down through the same queue
rung 4 already defines, not because a process stayed alive.

**Work that is long-running by nature.** Some tasks are not merely large: they hold a
connection open, or stream for an hour, or genuinely run past any Lambda budget you could
justify. Decomposition does not help there. The escape hatch is that rung 4's contract
never mentions Lambda — [docs/10-concurrency.md](10-concurrency.md) happens to draw it
with Lambdas, but the contract says only *consume from the queue, emit an intent*. An EC2
instance or a Fargate task can satisfy it as a peer: it reads the same queue and emits the
same kind of intent, and the coordinator cannot tell, and does not need to, which compute
produced it. That is the payoff for making the queue the seam
rather than the function: compute becomes a per-task choice, not an architectural one.

## Rung 6: tiered memory, a small knowledge graph, and scoped permissions

> **Not implemented in this repo, and the most speculative rung on the ladder.** It names
> a specific external package as an illustration of what rung 4's central memory could
> look like in a fuller form. Nothing here is a recommendation to adopt it in this
> tutorial, and no dependency is implied.

Rung 4 named the central memory without saying what it is shaped like; here it is four
tables, one of them a `sqlite-vec` index. A hierarchy wants more than that, and
[`@equationalapplications/core-llm-wiki`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md)
— a platform-agnostic TypeScript memory engine built for hybrid LLM memory over SQLite —
happens to be organized around four things a hierarchy needs.

**Namespacing.** Its `entityId` is the identifier a hierarchy is already missing: each
orchestrator, sub-agent, or task line reads and writes its own namespace via
`write(entityId, { event_type, summary })`, and a coordinator can read across several at
once, because `read()` accepts one entity id or an array of them.

**Tiering.** Those namespaces can be weighted rather than merely merged. The README's own
example reads `['tier_wisdom', 'tier_fact', 'tier_working']` with `tierWeights` of `2`,
`1`, and `0.25` — durable curated knowledge dominating, an in-flight sub-agent's working
context nearly discounted. Tiers are just entity ids with a naming convention.

**A small knowledge graph.** A per-entity seeded ontology (`node_types` and `edge_types`,
under a `'strict'`, `'emergent'`, or `'off'` mode — `off` by default) lets stored facts
carry typed `edges` rather than opaque text. An intent coming back from a sub-agent can say
*this artifact was produced by that run* as a relationship, not a sentence to re-parse.

**Scoped permissions.** Because both reads and writes are already partitioned by
`entityId`, that partition is the natural enforcement point: restrict a low-trust leaf
agent to its own namespaces, or to specific tiers within one, and it cannot read or corrupt
a sibling's memory or the orchestrator's. The permission boundary a hierarchy needs is the
one the storage layer already draws.

## Where this repo stops

Rung 1, and nothing above it. The `fetch` tick is a real lightweight composable agent;
rungs 2 through 6 are a sketch of what it grows into, not a backlog.

For the concrete pieces a real implementation would draw on:
[docs/10-concurrency.md](10-concurrency.md) for the single-writer queue rungs 4 and 5 are
built on, [docs/05-from-tutorial-to-prod.md](05-from-tutorial-to-prod.md) for the exits from
SQLite-on-S3 once you need transactional consistency across agents, and `core-llm-wiki`'s
README for tiered memory, ontology, and scoped permissions.
