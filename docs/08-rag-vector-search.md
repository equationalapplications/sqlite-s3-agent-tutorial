# RAG: SQLite as a vector database too

The rest of this tutorial's docs show SQLite replacing a database *server* (see
[01-architecture.md](01-architecture.md)). This doc shows the same file replacing a
*vector database* too — no Pinecone, no pgvector, no separate service. The `sqlite-vec`
loadable extension turns a table in `memory.db` into a KNN index; Amazon Titan Text
Embeddings V2 turns text into the vectors that index stores.

## What actually happens, per `fetch` tick

Loop mode formats one combined message per tick (all of that tick's readings — weather
and crypto together — go into a single Bedrock `Converse` call), so RAG operates per tick,
not per source:

1. The chat model formats the tick's readings into a message: a friendly comment plus a
   closing haiku (`preMessage` in `src/agent/fetch.ts`). The model is never told about
   past history — RAG is entirely mechanical, applied *after* this call returns.
2. `preMessage` is embedded once (Titan) and searched against `agent_embeddings` for the
   closest past tick, **across all sources** — no same-source filter. First tick ever?
   No match — nothing to search yet.
3. If a match exists, its `base_message` (see below) is appended to `preMessage` as a
   mechanical `"\n\nReminds me of: <text>"` suffix, bounded to Discord's 2000-character
   limit. This is string concatenation in `src/agent/fetch.ts`'s
   `buildFinalMessageForDiscord` — the LLM has no part in it.
4. The resulting message posts to Discord.
5. The *same* vector computed in step 2 (not a second Titan call) is stored in
   `agent_embeddings`, becoming a candidate for a future tick's search. One row is
   inserted per source that had a reading this tick, all pointing at that source's own
   `agent_notifications` row but sharing the one embedding computed for the tick.

One Titan call per tick, not two — `preVector` is computed once and reused for both the
search (step 2) and the store (step 5). There is no dedup in this tutorial (see
[03-schema.md](03-schema.md)): every tick reaches every step above.

## Why `base_message` is a separate column from `formatted_message`

The suffix in step 3 is built from the matched tick's `base_message` — its pre-suffix
LLM output — never its `formatted_message`, which may itself already carry a
`"Reminds me of"` suffix from *its own* match. Building the suffix from
`formatted_message` would let a chain of matches snowball: tick 3's suffix would quote
tick 2's message, which already quotes tick 1's, growing without bound and eventually
exceeding Discord's 2000-character cap. Embedding and matching are also keyed off
`preMessage`/`base_message`, not `formatted_message`, for the same reason: a query vector
computed from an already-suffixed message would drift the corpus toward matching on
suffix text rather than on the tick's own content.

## Why one `agent_embeddings` table, not one per source

Sources are a closed vocabulary maintained in exactly one place — `SOURCE_NAMES` in
`src/db/schema.ts` (see [04-extending.md](04-extending.md)). A vector table per source
would mean editing a second place every time a source is added, breaking that invariant.
`agent_embeddings` is one table across every source, and `findNearestMatch`
(`src/rag/similarity.ts`) runs a global KNN — no per-source filter at all, by design: the
match is "the most similar past tick," not "the most similar past reading for this
specific source." The scan is capped at the 50 closest candidates (`KNN_CANDIDATES`); at
5-minute cadence that's roughly two hours of wall-clock history, which is generous for
this tutorial's short-lived intended test runs but means `findNearestMatch` can miss a
true nearest neighbor further back in a corpus that's grown past that ceiling.

## Seeing it work

The `status` endpoint's `recentNotifications[]` includes a `nearestMatch` field per
notification — `null` if there was no history yet (or the embedding step failed and was
isolated, see below), otherwise the matched notification's own source, **posted**
`formattedMessage` (its full text as it appeared in Discord, suffix included — not the
`base_message` that was actually used to build *this* notification's own suffix), postedAt
date, and the cosine distance between the two vectors. This is read straight off plain
columns on `agent_notifications` (`nearest_match_id`, `nearest_match_distance`, joined back
to the matched row) — the reader never runs a vector query itself, only the writer does.

## What happens when Titan is unavailable

Both the search and the store lookups are wrapped in the same tick-level error isolation
`runFetch` already has for formatter/post failures: a Titan failure at the search-or-store
step is caught, logged into `agent_runs.error`, and the tick still posts to Discord with no
suffix — it never blocks the post. See [03-schema.md](03-schema.md)'s explanation of why
`agent_runs.error` exists.

## Out of scope

- Cross-source similarity search framing (the KNN itself is already global/cross-source —
  what's out of scope is a *deliberate* "closest crypto price to today's weather" feature,
  which isn't semantically meaningful for this tutorial's two sources).
- A configurable embedding model or dimension count (fixed at Titan v2 / 256 dims — the
  fixed value avoids a "how do I migrate the corpus" problem this tutorial doesn't need).
- Backfilling embeddings for notifications posted before this feature shipped — the
  corpus starts growing from the first `fetch` run after deploying this.
- A similarity threshold below which nothing gets mentioned — every match found is used,
  regardless of distance, to keep the demo mechanical and simple to test.
- Per-source KNN filtering via `sqlite-vec` partition-key columns — would fix the "match
  might not be same-source" trade-off above, but requires a schema migration and backfill
  this tutorial doesn't need at its scale (see [docs/09-lesson-script.md](09-lesson-script.md)
  Lesson 7 for the reasoning).
