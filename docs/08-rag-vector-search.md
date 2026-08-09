# RAG: SQLite as a vector database too

The rest of this tutorial's docs show SQLite replacing a database *server* (see
[01-architecture.md](01-architecture.md)). This doc shows the same file replacing a
*vector database* too — no Pinecone, no pgvector, no separate service. The `sqlite-vec`
loadable extension turns a table in `memory.db` into a KNN index; Amazon Titan Text
Embeddings V2 turns text into the vectors that index stores.

## What actually happens, per source, per `fetch` run

1. A new value shows up (dedup already ruled out "unchanged from yesterday" before this
   point — see [03-schema.md](03-schema.md)).
2. The raw value gets embedded (Titan) and searched against `agent_embeddings` for the
   closest **same-source** past notification. First-ever notification for a source? No
   match — nothing to search yet.
3. If a match exists, its text and date go into the same Bedrock prompt that formats
   today's message — the model may naturally reference it ("looks like last Tuesday's
   reading!"), but isn't required to.
4. The message posts to Discord as usual.
5. The *formatted* message — not the raw value — gets embedded and stored, becoming a
   candidate for tomorrow's (or next week's) search.

Two Titan calls per posted notification: one to search with (step 2, embeds the raw
value, since the formatted message doesn't exist yet), one to store with (step 5, embeds
the formatted message, since that's the richer, more semantically meaningful text and by
this point it exists). Deduped/unchanged values never reach either call — same principle
as the LLM formatting call already skipping unchanged values (spec: `docs/03-schema.md`).

## Why one `agent_embeddings` table, not one per source

Sources are a closed vocabulary maintained in exactly one place — `SOURCE_NAMES` in
`src/db/schema.ts` (see [04-extending.md](04-extending.md)). A vector table per source
would mean editing a second place every time a source is added, breaking that invariant.
Instead, `agent_embeddings` is one table across every source, and same-source filtering
happens in application code (`src/rag/similarity.ts`'s `findNearestMatch`): a fixed KNN
scan of the 50 closest vectors *regardless of source*, then a filter down to the
requested source, then the closest survivor. Good enough for a workload that grows by at
most a couple of rows a day — not engineered for a corpus where the true nearest
same-source match might not be among the 50 closest across all sources combined.

## Why the query embeds the raw value but the stored embedding is the formatted message

This is the one asymmetry worth calling out. At search time (step 2 above), the
notification hasn't been formatted yet — there's nothing to embed *except* the raw
value. At store time (step 5), the formatted message exists, and it's the more
semantically rich text (Titan famously embeds "a sunny 72°F afternoon" more usefully than
it embeds the bare string "72F"). Both go through the same embedding model, into the same
256-dimension space, so a raw-value query against formatted-message-embedded history still
works — Titan doesn't require its inputs to share a style, just a language.

## Seeing it work

The `status` endpoint's `recentNotifications[]` includes a `nearestMatch` field per
notification — `null` if there was no history yet (or the embedding step failed and was
isolated, see below), otherwise the matched notification's own source/message/date and
the cosine distance between the two vectors. This is read straight off two plain columns
on `agent_notifications` (`nearest_match_id`, `nearest_match_distance`) — the reader never
runs a vector query itself, only the writer does.

## What happens when Titan is unavailable

Both embedding calls (search and store) are wrapped in the same per-source error
isolation `runFetch` already has for fetch/format/post failures. A Titan outage degrades
this feature to "no similarity mentioned today" — it never blocks the Discord post, and
it shows up in `agent_runs.error` like any other per-source failure (see
[03-schema.md](03-schema.md)'s explanation of why that column exists).

## Out of scope

- Cross-source similarity search (a "closest crypto price to today's weather" comparison
  isn't semantically meaningful for this tutorial's two sources).
- A configurable embedding model or dimension count (fixed at Titan v2 / 256 dims — the
  fixed value avoids a "how do I migrate the corpus" problem this tutorial doesn't need).
- Backfilling embeddings for notifications posted before this feature shipped — the
  corpus starts growing from the first `fetch` run after deploying this.
- A similarity threshold below which nothing gets mentioned — every match found is used,
  regardless of distance, to keep the demo mechanical and simple to test.
