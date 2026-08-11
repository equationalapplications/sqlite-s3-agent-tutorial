# Composable Agents Doc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `docs/12-composable-agents.md` — a conceptual page that names this tutorial's Lambda as a lightweight composable cloud agent, then climbs a six-rung ladder from it to hierarchical orchestration with tiered memory — and add its row to the README doc index.

**Architecture:** Documentation only. One new markdown file built up over four commits (intro + rung 1; rungs 2–3; rungs 4–5; rung 6 + closing), then a one-line README table edit, then a verification pass. Every rung past the first opens with a blockquote marking it as not implemented in this repo, and cross-links back to `01-architecture.md`, `10-concurrency.md`, or `05-from-tutorial-to-prod.md` for the pieces a real implementation would draw on.

**Tech Stack:** Markdown only. No changes to `src/`, `infra/`, `tests/`, `package.json`, `Dockerfile`, or any config file. No new dependencies — the external package named in rung 6 is cited as an illustration, never installed.

**Spec:** `docs/superpowers/specs/2026-08-11-composable-agents-design.md`

---

## Context the implementing engineer needs

You have not seen this repo. It is a tutorial: one AWS Lambda container-image function on a 5-minute EventBridge schedule fetches a couple of data sources, calls Bedrock twice (a chat model to format a message, Titan to embed it), posts to a Discord webhook, and writes a single SQLite file back to one S3 object using a conditional write. That's the whole system.

Read these three docs before Task 1 — they are short, and the new page cross-links all of them:

- `docs/01-architecture.md` (73 lines) — **the style template.** Match it: sentence-case `##` headings, prose wrapped at roughly 90 columns, links written as `[docs/NN-name.md](NN-name.md)` (repo-relative label, sibling-relative target — that is the existing convention inside `docs/`), no bullet-heavy structure where a paragraph will do.
- `docs/10-concurrency.md` (157 lines) — rungs 4 and 5 lean on its `## High contention: the single-writer queue` section (line 107) and its ASCII diagram (lines 114–127). Do not redraw that diagram; link to it.
- `docs/05-from-tutorial-to-prod.md` (49 lines) — named in the closing note as the exits from SQLite-on-S3.

Facts verified against this repo — do not restate them differently:

| Fact | Source |
|---|---|
| The schedule's EventBridge `Input` is the literal string `{"op":"fetch"}` | `docs/01-architecture.md:66-73` |
| The function has two ops read from `event.op`: `fetch` (writer, scheduled) and `status` (reader, Function URL with `authType: AWS_IAM`) | `docs/01-architecture.md:3-9` |
| Warm invocations share `/tmp`; the status reader deliberately reuses its cached handle, and `/tmp` survives until a redeploy | `docs/01-architecture.md:10-12`, `docs/02-rehydration.md:89-91` |
| `reservedConcurrentExecutions: 1` is the tutorial default for this one Lambda function (overridable via `RESERVED_CONCURRENCY`); the conditional write is a second line of defense scoped to the S3 object | `docs/01-architecture.md:44-52` |
| The high-contention answer is: read-only agents, writes serialized as SQS messages, one pinned coordinator with concurrency 1, batched apply | `docs/10-concurrency.md:107-142` |
| Docs 10 already uses the words **intent** and **coordinator** for exactly these roles | `docs/10-concurrency.md:131-134` |
| The README doc index table runs `docs/01…docs/11`, then `bedrock-model-comparison.md` last as the only unnumbered row | `README.md:176-187` |

External API surface cited in rung 6 was **verified on 2026-08-11** against
`https://raw.githubusercontent.com/equationalapplications/expo-llm-wiki/main/packages/core/README.md`. Confirmed verbatim: package name `@equationalapplications/core-llm-wiki`; class `WikiMemory`; `entityId`; `write(entityId, { event_type, summary })`; `read()` accepting one entity id or an array; `tierWeights`; ontology modes `'strict'` / `'emergent'` / `'off'` (default `off`); `node_types` / `edge_types` in a seed manifest; facts carrying inline `edges` with `edge_type` / `target_title`.

**One correction to the spec.** The spec describes `tier_wisdom` / `tier_fact` / `tier_working` as tier names. They are not: in that README they are **entity ids** — ordinary namespaces that happen to be named after tiers — and `tierWeights` assigns each a weight. The verified example is:

```typescript
const memory = await wikiMemory.read(
  ['tier_wisdom', 'tier_fact', 'tier_working'],
  'Which source should I trust?',
  { maxResults: 8, tierWeights: { tier_wisdom: 2, tier_fact: 1, tier_working: 0.25 } },
);
```

The drafted prose in Task 4 already reflects this. Write it as drafted; do not "fix" it back toward the spec's wording.

---

## File Structure

- **Create** `docs/12-composable-agents.md` — the only new file. Built over Tasks 1–4, one commit per section group, so every commit leaves a readable document. Target 120–180 lines total; the drafted content lands at roughly 155.
- **Modify** `README.md` — insert one row in the doc index table, immediately above the `bedrock-model-comparison.md` row. Task 5.

Not touched: every other file in the repo, including the other files in `docs/`. Historical records under `docs/superpowers/plans/` and `docs/superpowers/specs/` are never rewritten, with one exception: the single `## Status` line of this approved spec flips from `Approved` to `Implemented` in Task 6, and that one-line edit is the only change made to a spec file by this plan.

---

## Task 0: Branch check

**Files:** none

- [ ] **Step 1: Confirm the working tree is clean and you are on the right branch**

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
```

Expected: branch `docs/composable-agents-spec-revisions`, and empty output from `git status --porcelain`.

The approved spec is already committed on this branch (`e07ec43`), so stay on it — do not create a new branch. If `git rev-parse` prints `main` instead, the spec commits are missing; stop and ask, rather than branching from a tree that lacks the spec.

---

## Task 1: Intro and rung 1

**Files:**
- Create: `docs/12-composable-agents.md`

- [ ] **Step 1: Write the opener and rung 1**

Create `docs/12-composable-agents.md` with exactly this content:

````markdown
# Composable agents

A **lightweight, composable cloud agent** is a thing that spins up, does a few minutes —
or a few seconds — of work, and goes away. No process stays resident. The agent carries
no state in memory that has to outlive an invocation; whatever has to outlive one run
gets written down somewhere durable before the agent exits.

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
````

- [ ] **Step 2: Verify the file renders and the links resolve**

```bash
wc -l docs/12-composable-agents.md
for f in 01-architecture.md 02-rehydration.md 10-concurrency.md; do test -f "docs/$f" && echo "ok $f"; done
```

Expected: about 55 lines, and three `ok` lines.

- [ ] **Step 3: Commit**

```bash
git add docs/12-composable-agents.md
git commit -m "docs(agents): name the fetch tick as a lightweight composable agent"
```

---

## Task 2: Rungs 2 and 3

**Files:**
- Modify: `docs/12-composable-agents.md` (append)

- [ ] **Step 1: Append rungs 2 and 3**

Append exactly this to the end of `docs/12-composable-agents.md`:

````markdown

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
````

- [ ] **Step 2: Verify**

```bash
wc -l docs/12-composable-agents.md
grep -c "Not implemented in this repo" docs/12-composable-agents.md
```

Expected: about 100 lines; `grep -c` prints `2` — one per new rung. The intro paragraph
says the same thing in prose and does not contain that literal phrase, so it is not
counted.

- [ ] **Step 3: Commit**

```bash
git add docs/12-composable-agents.md
git commit -m "docs(agents): add to-do list and delegation rungs"
```

---

## Task 3: Rungs 4 and 5

**Files:**
- Modify: `docs/12-composable-agents.md` (append)

- [ ] **Step 1: Append rungs 4 and 5**

Append exactly this to the end of `docs/12-composable-agents.md`:

````markdown

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
asynchronous, and at-least-once delivery means the coordinator's apply step has to be
idempotent.

This rung also gives the master object a name it will need later. Seen from inside the
hierarchy, it is the **central memory**: the one shared thing every agent's intents
eventually land in, and the only place where the system's state is authoritative. Rung 6
is about what that memory could be shaped like.

## Rung 5: follow-up tasks and the EC2 escape hatch

> **Not implemented in this repo.**

Two things break the ladder if left unaddressed, and both are answered by pieces already
on it.

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
does not mention Lambda anywhere — it says *consume from the queue, emit an intent*. An
EC2 instance or a Fargate task can satisfy that contract as a peer. It reads the same
queue and emits the same kind of intent, and the coordinator cannot tell, and does not
need to, which compute produced it.

That is the payoff for making the queue the seam rather than the function: the choice of
compute becomes a per-task decision instead of an architectural one.
````

- [ ] **Step 2: Verify the anchor link is correct**

The link `10-concurrency.md#high-contention-the-single-writer-queue` must match GitHub's
slug for that heading. Confirm the heading text:

```bash
grep -n "^## High contention" docs/10-concurrency.md
```

Expected: `107:## High contention: the single-writer queue`. GitHub slugifies that to
`high-contention-the-single-writer-queue` (lowercased, spaces to hyphens, colon dropped).
If the heading text differs from the above, regenerate the anchor by the same rule rather
than keeping the drafted one.

```bash
wc -l docs/12-composable-agents.md
```

Expected: about 145 lines.

- [ ] **Step 3: Commit**

```bash
git add docs/12-composable-agents.md
git commit -m "docs(agents): add intent-queue and follow-up/escape-hatch rungs"
```

---

## Task 4: Rung 6 and the closing note

**Files:**
- Modify: `docs/12-composable-agents.md` (append)

Every identifier below was verified on 2026-08-11 against the upstream README (see the
context section). Write it as drafted. If you re-check the README and something has since
changed, drop or soften that specific rather than guessing at a replacement — this rung is
an illustration, and a wrong API name is worse than a vaguer sentence.

- [ ] **Step 1: Append rung 6 and the closing note**

Append exactly this to the end of `docs/12-composable-agents.md`:

````markdown

## Rung 6: tiered memory, a small knowledge graph, and scoped permissions

> **Not implemented in this repo, and the most speculative rung on the ladder.** It names
> a specific external package as an illustration of what rung 4's central memory could
> look like in a fuller form. Nothing here is a recommendation to adopt it in this
> tutorial, and no dependency is implied.

Rung 4 named the central memory without saying what it is shaped like. In this repo it is
two flat tables. A hierarchy of agents wants more than that, and
[`@equationalapplications/core-llm-wiki`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/packages/core/README.md)
— a platform-agnostic TypeScript memory engine built for hybrid LLM memory over SQLite —
happens to be organized around four things a hierarchy needs.

**Namespacing.** Its `entityId` is the identifier a hierarchy is already missing: each
orchestrator, sub-agent, or task line reads and writes its own namespace via
`write(entityId, { event_type, summary })`. A coordinator can read across several at once,
because `read()` accepts either one entity id or an array of them.

**Tiering.** Those namespaces can be weighted rather than merely merged. The README's own
example reads `['tier_wisdom', 'tier_fact', 'tier_working']` with `tierWeights` of `2`,
`1`, and `0.25` — durable curated knowledge dominating, an in-flight sub-agent's working
context present but nearly discounted. The tiers are just entity ids with a naming
convention and different weights, which is why the same mechanism serves both purposes.

**A small knowledge graph.** A per-entity seeded ontology (`node_types` and `edge_types`,
under a `'strict'`, `'emergent'`, or `'off'` mode — `off` by default) lets stored facts
carry typed `edges` rather than opaque text. An intent coming back from a sub-agent can
say *this artifact was produced by that run* as a typed relationship instead of a sentence
someone has to re-parse later.

**Scoped permissions.** Because both reads and writes are already partitioned by
`entityId`, that partition is the natural enforcement point: restrict a low-trust leaf
agent to its own namespaces, or to specific tiers within one, and it cannot read or
corrupt a sibling's memory or the orchestrator's. The permission boundary a hierarchy
needs turns out to be the same boundary the storage layer already draws.

## Where this repo stops

Rung 1, and nothing above it. The `fetch` tick is a real lightweight composable agent;
rungs 2 through 6 are a sketch of what it grows into, not a backlog.

For the concrete pieces a real implementation would draw on:
[docs/10-concurrency.md](10-concurrency.md) for the single-writer queue that rungs 4 and 5
are built on, [docs/05-from-tutorial-to-prod.md](05-from-tutorial-to-prod.md) for the
exits from SQLite-on-S3 once you need transactional consistency across agents, and
`core-llm-wiki`'s README for tiered memory, ontology, and scoped permissions.
````

- [ ] **Step 2: Verify length and the external link**

```bash
wc -l docs/12-composable-agents.md
```

Expected: 150–175 lines. The spec's target band is 120–180; if you are over 180, tighten
prose rather than dropping a rung.

```bash
curl -sI https://raw.githubusercontent.com/equationalapplications/expo-llm-wiki/main/packages/core/README.md | head -1
```

Expected: `HTTP/2 200`. A 404 means the repo or path moved — fix the link in the doc
before committing.

- [ ] **Step 3: Commit**

```bash
git add docs/12-composable-agents.md
git commit -m "docs(agents): add tiered-memory rung and closing note"
```

---

## Task 5: README doc index row

**Files:**
- Modify: `README.md` (the doc index table, around line 186)

- [ ] **Step 1: Locate the insertion point**

```bash
grep -n "bedrock-model-comparison.md) | Why" README.md
```

Expected: one hit, around line 187. The new row goes **immediately above** it — the
comparison doc is the only unnumbered row and stays last.

- [ ] **Step 2: Insert the row**

Add this line directly above that `bedrock-model-comparison.md` row:

```markdown
| [docs/12-composable-agents.md](docs/12-composable-agents.md) | The fetch tick as a lightweight composable agent, and the ladder up from it |
```

Note the link form: rows in this table use the full `docs/…` path in both label and
target, unlike links *inside* `docs/`, which are sibling-relative. Match the table.

- [ ] **Step 3: Verify the table order**

```bash
grep -n "^| \[docs/" README.md
```

Expected: rows `01` through `11` in order, then the new `12` row, then
`bedrock-model-comparison.md` last.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add composable agents to the doc index"
```

---

## Task 6: Final verification

**Files:** none

- [ ] **Step 1: Check every relative link in the new doc resolves**

```bash
grep -oE "\]\([0-9a-z-]+\.md" docs/12-composable-agents.md | sed 's/](//' | sort -u | while read -r f; do
  test -f "docs/$f" && echo "ok  $f" || echo "BROKEN  $f"
done
```

Expected: `ok` for `01-architecture.md`, `02-rehydration.md`, `05-from-tutorial-to-prod.md`,
and `10-concurrency.md`. Any `BROKEN` line must be fixed before finishing.

- [ ] **Step 2: Confirm the doc is conceptual-only — no code or infra changed**

```bash
git diff --stat main...HEAD -- src infra tests package.json package-lock.json Dockerfile
```

Expected: empty output. Anything listed here violates the spec's non-goals; revert it.

- [ ] **Step 3: Confirm every rung past the first is marked**

```bash
grep -c "Not implemented in this repo" docs/12-composable-agents.md
```

Expected: `5` — one blockquote per rung, rungs 2 through 6.

- [ ] **Step 4: Confirm the whole spec is covered**

```bash
grep -n "^#" docs/12-composable-agents.md
```

Expected eight headings in this order: `# Composable agents`, then
`## Rung 1: the fetch tick is already one`, `## Rung 2: a to-do list instead of one fixed
job`, `## Rung 3: delegation and hierarchy`, `## Rung 4: intents through a queue, not
direct writes`, `## Rung 5: follow-up tasks and the EC2 escape hatch`, `## Rung 6: tiered
memory, a small knowledge graph, and scoped permissions`, `## Where this repo stops`.

- [ ] **Step 5: Mark the spec implemented**

Edit `docs/superpowers/specs/2026-08-11-composable-agents-design.md` line 5, replacing:

```markdown
Approved — ready for writing-plans.
```

with:

```markdown
Implemented — `docs/12-composable-agents.md`.
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-11-composable-agents-design.md
git commit -m "docs(spec): mark composable agents design implemented"
```

Then hand off to `superpowers:finishing-a-development-branch` for the PR.
