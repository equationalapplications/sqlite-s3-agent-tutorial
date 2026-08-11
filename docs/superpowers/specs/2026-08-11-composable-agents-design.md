# Design: `docs/12-composable-agents.md` — composable, lightweight cloud agents

## Status

Implemented — `docs/12-composable-agents.md`.

## Summary

Add a new documentation page, `docs/12-composable-agents.md`, that reframes this
tutorial's single Lambda as one concrete instance of a general pattern: a
**lightweight, composable cloud agent** — something that spins up, does a few
minutes (or seconds) of work, and goes away. The doc is conceptual only. It adds
no code, no new infrastructure, and no new tables to this repo. Its job is to
name a pattern the reader has already built, then walk it — rung by rung — toward
the fuller shape that pattern can take: a to-do list, delegated sub-agents,
hierarchy, intents flowing back through a message queue, follow-up tasks, an
EC2/Fargate escape hatch for genuinely long-running work, and — as an
illustrative extension — a tiered, ontology-aware "central memory" with
scoped, multi-agent permissions.

This is documentation-only work. No implementation plan beyond writing the page
itself is expected; `writing-plans` here produces a short plan for drafting and
committing one markdown file, not a code change.

## Placement

New file: `docs/12-composable-agents.md`, numbered to sit alongside the existing
`01`–`11` docs. Add it to the doc index table the README maintains (the same way
`10ba1c7` added `11-aws-bedrock-setup.md` to that index), following the existing
entries' format and tone: `| [docs/NN-name.md](docs/NN-name.md) | one-line
description |`. Two details:

- The index table is the only place to add an entry. The README links to
  individual docs in prose elsewhere; leave those alone.
- `bedrock-model-comparison.md` sits last in the table as the only unnumbered
  row, so the `12-` row goes immediately above it, not at the bottom.

## Length and format

Target roughly 120–180 lines — in the range of the existing conceptual docs
(`01`–`08`, `10` run 49–157 lines) rather than the two long procedural ones
(`09` and `11`, 431 and 476). A six-rung ladder can easily outgrow both if each
rung is allowed to sprawl; keep each rung to a few tight paragraphs.

ASCII diagrams are optional and should be used sparingly if at all.
`10-concurrency.md` uses two fenced blocks; `01-architecture.md` uses none.
Rung 4 is the one place a diagram might earn its keep — and it can instead just
cross-link the diagram `10-concurrency.md` already has.

## Audience and thesis

Primary teaching goal: **"you already built one of these."** The reader has
just finished (or is working through) a tutorial that ships a single Lambda
function on a 5-minute EventBridge schedule. This doc's job is to name that
Lambda as an instance of a broader, well-known shape — the lightweight
composable cloud agent — and then generalize outward from the concrete thing
they already have, rather than presenting an abstract architecture first and
retrofitting the tutorial onto it second.

## Structure: a ladder from the existing Lambda to full hierarchical orchestration

The doc is organized as eight sections — an intro, six rungs, and a closing
note — each rung one step up from the last. Every
rung beyond the first is explicitly marked as **not implemented in this repo** —
conceptual, not a call to action — and cross-links back to the existing docs
(`01-architecture.md`, `10-concurrency.md`, `05-from-tutorial-to-prod.md`) that
already contain the pieces a real implementation would draw on.

### 1. Intro: naming the pattern

Opens by naming the pattern in the first paragraph: a lightweight, composable
cloud agent is something that spins up, does a few minutes of work, and goes
away — no persistent process, and no state in memory that correctness depends on
holding. States immediately that this tutorial already built one. The rest of the page is a
ladder from that one concrete instance up to the general pattern.

### 2. Rung 1 — the fetch tick as a lightweight agent

Maps the existing pieces onto the pattern's vocabulary with no new concepts
introduced:

- **Heartbeat** = the EventBridge 5-minute schedule described in
  `01-architecture.md` (`{"op":"fetch"}` as the literal `Input`).
- **Spin up, work, go away** = one Lambda invocation: hydrate from S3, call
  Bedrock twice, post to Discord, conditional-write back, exit.
- **Statelessness between runs** = no *durable* state is held in `/tmp`. Warm
  containers may reuse it — `01-architecture.md` leans on exactly that to let
  the status reader work, and `02-rehydration.md` notes it survives until a
  redeploy — but correctness never depends on it. Everything that has to
  outlive an invocation lives in the S3-backed SQLite file, not in the agent
  process. State the nuance rather than claiming `/tmp` is simply disposable;
  a reader who has finished doc 01 will know better.
- **Why this is "composable"**: because the agent carries no durable in-memory
  state across invocations, the conditional-write invariant in `10-concurrency.md`
  is what makes a second agent possible — it prevents two invocations from
  silently clobbering the S3 object. That protection is scoped to the S3 object:
  it does not serialize separate Lambda functions, and any side-effecting
  operations the agent performs before the write are not made idempotent by it.
  The single-writer queue (rung 4) is the seam that does both.

This rung is the load-bearing one: it makes the doc's central claim concrete
before generalizing. "Lightweight cloud agent" is not a new abstraction being
introduced — it's a name for what is already running.

### 3. Rung 2 — a to-do list instead of one fixed job

Today the orchestrator's task is hardcoded: every tick does the same fetch.
This rung generalizes that to a to-do list the orchestrator consults each
heartbeat — conceptually, a table of pending work items (could live in the
same SQLite file, consistent with the "one file" philosophy in
`01-architecture.md`) instead of one implicit job. The orchestrator's loop
becomes: wake on heartbeat → read to-do list → decide what's due → act.
Explicitly marked as not implemented here, the same way `10-concurrency.md`
frames the single-writer-queue as a next step rather than something the
tutorial builds.

### 4. Rung 3 — delegation and hierarchy

Instead of the orchestrator doing the work itself, it spins up a sub-agent
invocation (another Lambda call) scoped to one to-do item — and that sub-agent
can itself spin up further sub-agents for pieces of its own task, recursively,
not just one level of fan-out. Names the forcing constraint explicitly:
Lambda's ~15-minute runtime ceiling means any unit of work that might run long
must be decomposable into smaller delegated pieces rather than done inline.
Ties back to the single-writer invariant from `10-concurrency.md`: delegation
multiplies *invocations*, not *writers* — sub-agents don't each get their own
S3 conditional-write; that's rung 4.

### 5. Rung 4 — intents through a message queue, not direct writes

Once there's a hierarchy, sub-agents can't all conditional-write to the shared
S3 file directly — that's exactly the contention problem `10-concurrency.md`'s
"High contention: the single-writer queue" section already diagrams and
solves. This rung names that diagram as the answer, framed as direct reuse
rather than a new pattern: sub-agents finish their scoped work and emit an
**intent** — a message describing what changed, not a rewritten file — onto a
queue; a single coordinator drains the queue and is the only thing that
touches the master S3 object. Includes an explicit cross-link to that section.

This rung must also introduce the term **central memory** for the master S3
object as seen from the hierarchy's point of view — the one shared thing every
agent's intents eventually land in. Rung 6 builds directly on that term, so it
has to be named here rather than appearing for the first time later.

### 6. Rung 5 — follow-up tasks and the EC2 escape hatch

Handles work that exceeds a single invocation; rung 6 follows immediately.
When a sub-agent's work doesn't finish within its own invocation, it doesn't
retry-loop inside Lambda — it emits an intent describing a follow-up item for
the to-do list (rung 2's table). The coordinator applies the intent on its
next drain, and the orchestrator picks the item up on a later heartbeat. When
a task's *nature* is long-running rather than just large — something that must
hold a connection open, or genuinely runs past any reasonable Lambda budget
— the same message-queue contract from rung 4 lets an EC2 or Fargate worker
participate as a peer: it consumes from the same queue and emits the same
kind of intent. The orchestrator doesn't need to know or care which compute
produced it.

### 7. Rung 6 — tiered memory, a basic knowledge graph, and scoped permissions

Rung 4 named "central memory" as the thing a coordinator writes intents into,
without saying what that memory is shaped like. This rung points to a concrete
answer: [`@equationalapplications/core-llm-wiki`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md)
(specifically `packages/core/README.md` in that repo), a platform-agnostic
TypeScript memory engine already built for hybrid LLM memory over SQLite. The
mapping is conceptual, not a dependency this repo takes on:

- **Multi-agent namespacing.** `WikiMemory`'s `entityId` is the identifier a
  hierarchy of agents needs: each orchestrator, sub-agent, or task line
  reads/writes its own `entityId` namespace, or a coordinator reads across
  several in one call (`read([entityIdA, entityIdB], …)`).
- **Tiered memory.** `tierWeights` is a per-entity multiplier applied to
  retrieval scores — a hierarchy can group its entity ids by convention
  (e.g. `tier_wisdom` for durable curated knowledge, `tier_fact` for
  established facts, `tier_working` for in-flight sub-agent context) and
  weight each group as a "tier" without any of those names being built in.
  `tier_wisdom` / `tier_fact` / `tier_working` are ordinary entity ids; the
  tiers they denote live in the naming convention and the weight map.
- **Basic knowledge graph.** The per-entity seeded ontology (`strict` /
  `emergent` / `off` modes, `node_types`/`edge_types`, typed facts with
  inline `edges`) is a lightweight graph layer: intents coming back from
  sub-agents can carry typed relationships (e.g. `task --produced_by-->
  sub_agent_run`) rather than opaque text blobs.
- **Scoped permissions.** Because retrieval and writes are already
  partitioned by `entityId`, restricting a given sub-agent's coordinator
  access to specific entity namespaces (or specific tiers within one) is a
  natural enforcement point for "this sub-agent may only see/write its own
  scope" — the same boundary a hierarchy needs to keep a low-trust leaf agent
  from reading or corrupting a sibling's or the orchestrator's memory.

This rung is explicitly the most speculative: it names a specific external
package as an illustration of what the central memory from rung 4 could look
like in a fuller form, not a recommendation to adopt it in this tutorial. No
code or dependency changes are implied.

**Verification (2026-08-11).** All external API surface cited above —
`WikiMemory`, `entityId`, `tierWeights`, the `tier_wisdom` / `tier_fact` /
`tier_working` namespaces, `node_types` / `edge_types`, the `strict` /
`emergent` / `off` ontology modes, the `read([entityIdA, entityIdB], …)`
signature — and the repo / package URL (`equationalapplications/expo-llm-wiki`,
`@equationalapplications/core-llm-wiki`) were verified against the upstream
README on 2026-08-11, prior to drafting. The implementation plan also records
the corrected entity-id semantics: `tier_wisdom` / `tier_fact` / `tier_working`
are ordinary entity ids, with `tierWeights` assigning each a weight. Re-verify
before relying on any specific that may have rotted since.

### 8. Closing note

Short closing paragraph: this repo implements rung 1 only. Rungs 2–6 are
conceptual. Points the reader to `10-concurrency.md` (single-writer queue),
`05-from-tutorial-to-prod.md` (exits from SQLite-on-S3), and
`core-llm-wiki`'s README (tiered memory, ontology, scoped permissions) as the
docs to read next for the concrete pieces a real implementation would draw on.

## Non-goals

- No new code, tables, or infrastructure in this repo.
- No Step Functions / SQS / DynamoDB task-table design — this was explicitly
  scoped out in favor of a conceptual-only page.
- No *parallel* vocabulary for concepts the existing docs already name. Where
  a doc already has a word for something — "conditional write," "single-writer,"
  "intent," "coordinator" — reuse that word rather than coining a synonym. The
  ladder does introduce terms of its own where nothing existing covers the
  concept ("heartbeat," "rung," "to-do list," "sub-agent," "central memory");
  that is expected. The rule is no duplicate names for the same idea, not zero
  new names.

## Open questions

None — all sections were reviewed and approved during brainstorming.
