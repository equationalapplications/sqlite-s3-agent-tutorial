# From tutorial to production

This tutorial's defaults are chosen for clarity, not for running a real business on. If
you outgrow it, here's what changes.

## Bucket lifecycle

This tutorial's bucket is `RemovalPolicy.DESTROY` with `autoDeleteObjects: true`, so
`cdk destroy` cleans up completely — useful for a tutorial you might spin up and tear down
several times while learning it. A production system generally wants
`RemovalPolicy.RETAIN`: losing the bucket should require a deliberate, separate action,
not be a side effect of a stack deletion.

## More than one writer path

This tutorial has exactly one thing that writes to the snapshot: the `fetch` op, on a
fixed daily schedule. A production agent is more likely to need multiple write paths — a
scheduled job and a manually-triggered one, say — which raises the question of whether
`reservedConcurrentExecutions: 1` is still sufficient once two *different* Lambda
functions might both want to write. It isn't, on its own: reserved concurrency only
serializes invocations of one function. Giving every
writer path the same conditional-write discipline this tutorial uses, so the S3 `If-Match`
precondition — not Lambda's concurrency control — is what actually prevents two writers
from clobbering each other, regardless of how many entry points call into that logic.

## The single Lambda split

This tutorial's `fetch` and `status` share one function because the reader's query is
cheap. If your reader starts doing real work — search, aggregation, anything with its own
latency and memory profile — split it into its own function. The two functions still share the storage pattern in this
tutorial's `docs/02-rehydration.md`; only the deployment topology changes.

## Model selection

This tutorial defaults to `zai.glm-4.7-flash` for cost — the whole daily notification
costs under $0.02/year at that price point (see `docs/bedrock-model-comparison.md`). A
production system with actual latency or quality requirements should probe candidates against your real
prompt, not against a price list, and pin the choice with the same "why not something
else" reasoning that doc records.

## What stays the same

The rehydration protocol — bootstrap, conditional writes, version-cached reads — doesn't
change shape as the system grows. That's the point of the pattern: it's the same mechanism
whether the payload is a two-table dedup cache or full knowledge graph
with a vector index. What changes is how much work happens between hydrate and publish,
not how hydrate and publish themselves work.
