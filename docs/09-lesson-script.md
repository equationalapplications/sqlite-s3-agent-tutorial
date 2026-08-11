# Lesson Script — RAG via `sqlite-vec` + Titan Embeddings

**Audience:** a teacher walking a student through the RAG extension.
**Length:** 10 lessons, roughly 30 minutes including the closing test run.
**Prerequisite:** the student has completed the base tutorial end-to-end, including the AWS setup in [11-aws-bedrock-setup.md](11-aws-bedrock-setup.md) — the RAG lesson assumes a deployed, working bot, and that doc is where to go if the base deploy is broken. The student has read [08-rag-vector-search.md](08-rag-vector-search.md) and the base tutorial's [01-architecture.md](01-architecture.md). Familiarity with the writer/reader asymmetry in [01-architecture.md](01-architecture.md) and the per-source error isolation in [03-schema.md](03-schema.md) is assumed.

## How to use this script

Each lesson opens with the *frame* (what concept you're trying to land) and closes with a *check-in question* — the kind you'd ask out loud, not as a written quiz. The expected reasoning for each question is given in a collapsed detail block so the teacher can read it before class but the student can't see it during the lesson.

End the session by running `npm test` from the repo root with the student watching. The expected output — **the whole suite passes** (the count of test files and the timing will drift as the suite grows; check the live output against today's count) — is the proof that the lesson landed.

---

## Lesson 1 — Why a vector database at all

The base tutorial established a substitution: **SQLite file in S3 replaces a database server.** This is the *second* substitution, made on top of the first:

> SQLite with the `sqlite-vec` extension replaces a vector database.

Same file. No Pinecone. No pgvector. No separate service.

Before going further, hold one constraint in your head — it shapes every decision that follows:

> **The `status` reader stays read-only and simple. It must not load `sqlite-vec` or run vector queries.** It only ever displays what the writer already computed and stored in plain columns.

The reader/writer asymmetry is the whole point of the base tutorial: the status Lambda only needs `s3:GetObject`, and giving it `s3:PutObject` would be a footgun. Carrying vector-search capability it never uses for writes would be the same kind of leak.

Mental model for the rest of the session:
- **Writer** does fetching, formatting, posting, embedding, and similarity lookup.
- **Reader** reads plain columns off the same file, including two new ones (`nearest_match_id`, `nearest_match_distance`) that the writer pre-computed.

**Check-in question:** if you were sketching this on a whiteboard, which side of the asymmetry would the `findNearestMatch` KNN call live on, and which side would the `NotificationStatus.nearestMatch` JSON field live on?

<details>
<summary>Expected reasoning</summary>

The KNN call lives on the **writer** side — only the writer loads `sqlite-vec`, only the writer has IAM for `bedrock:InvokeModel` on the Titan model. The `NotificationStatus.nearestMatch` JSON field is *produced* on the writer (the writer writes the columns that produce it), but the field is *read* on the reader side via a `LEFT JOIN` on plain columns — the reader never recomputes anything.

</details>

---

## Lesson 2 — The augmented loop

There is no dedup in this tutorial — every `fetch` tick posts, deliberately (see
[03-schema.md](03-schema.md)). RAG operates once per *tick*, over the combined
readings from every source, not once per source:

```
readings = [fetch(source) for source in sources]     # all sources, one tick

preMessage = bedrockFormat(readings)                 # ONE Converse call, no history involved

preVector = titanEmbed(preMessage)                   # NEW — one Titan call, reused below
match = findNearestMatch(db, preVector)               # NEW (global KNN, returns null if no history)

finalMessage = buildFinalMessageForDiscord(preMessage, match?.baseMessage)  # mechanical suffix
post(finalMessage)

for source in readings:
  notificationId = INSERT agent_notifications (
    ..., formatted_message=finalMessage, base_message=preMessage,
    nearest_match_id, nearest_match_distance          # NEW columns, same values for every source this tick
  )
  INSERT agent_embeddings (notificationId, preVector)  # NEW — reuses preVector, no second Titan call
```

Read this slowly. Three properties to land:

1. **One format call, one embed call, per tick — not per source.** The chat model sees every source's reading in one prompt and writes one combined message. That same message is embedded exactly once; the vector is reused both to search for a match and to store this tick's own entry. There is no per-source Bedrock or Titan call anywhere in this loop.

2. **The chat model is never told about the match.** Unlike a classic RAG design, `bedrockFormat` above takes no `match` argument — the model formats `readings` with zero knowledge of history. The suffix is pure string concatenation, applied by `buildFinalMessageForDiscord` *after* the Converse call returns. This is a deliberate simplification (Lesson 6 explains why).

3. **The two new columns are written once, at insert time, never updated.** Just like `agent_runs.outcome`/`error` in the base schema: absence is meaningful (first tick ever, or the embed/match step failed), not a placeholder. Every source's row from the same tick gets the same `nearest_match_id`/`nearest_match_distance`, because there's only one match per tick, not one per source.

The implementation lives in `src/agent/fetch.ts`.

**Check-in question:** what does "match = null" mean, and is it always the same "null"?

<details>
<summary>Expected reasoning</summary>

There are two distinct upstream causes that produce the same null:

1. This is the first tick ever (no prior notifications to match against).
2. The embed-or-match step failed and was isolated by the tick-level `try/catch`.

The doc deliberately collapses both into the same null. They have identical downstream behavior: no suffix on the posted message, both columns `NULL` in every inserted row, `nearestMatch: null` in the status endpoint. From any consumer's perspective, "nothing to mention" is the correct behavior in both cases.

</details>

---

## Lesson 3 — The data model

Three SQL statements do all the work:

```sql
-- 1. A new vec0 virtual table, one per *file* (not per source)
CREATE VIRTUAL TABLE IF NOT EXISTS agent_embeddings USING vec0(
  notification_id INTEGER PRIMARY KEY,
  embedding        FLOAT[256] distance_metric=cosine
);

-- 2. Three new nullable columns on the existing table
ALTER TABLE agent_notifications ADD COLUMN nearest_match_id INTEGER REFERENCES agent_notifications(id);
ALTER TABLE agent_notifications ADD COLUMN nearest_match_distance REAL;
ALTER TABLE agent_notifications ADD COLUMN base_message TEXT;
```

`base_message` stores the LLM's pre-suffix output — the text that was actually embedded and that a future match's suffix is built from. It's what makes the suffix mechanical rather than model-driven (Lesson 6) and what stops the suffix from snowballing across ticks (a suffix built from `formatted_message` would quote a message that may itself already carry a suffix).

Three things to internalize:

**A. One vector table across all sources.** Sources are a closed vocabulary maintained in exactly one place — `SOURCE_NAMES` in `src/db/schema.ts`. A per-source vector table would mean a second place to edit every time you add a source (a schema edit *and* a new virtual table). That breaks the invariant the base spec established in [04-extending.md](04-extending.md). There is no per-source filtering anywhere — the match is global across all sources, by design (Lesson 5).

**B. 256 dimensions, not 1024.** Titan V2 supports 256/512/1024 and is *explicitly tuned* to keep retrieval quality at 256. For a tutorial's corpus — a handful of rows per source, growing by at most a few a day — 1024 is overkill, and smaller vectors keep the storage and query cost visibly small. Deliberate teaching choice; the doc tells you why.

**C. The `ALTER TABLE` pattern is forced by SQLite.** SQLite has no `ADD COLUMN IF NOT EXISTS`. So the schema module guards each `ALTER` with a `PRAGMA table_info` check inside `bootstrap()`. This means a database bootstrapped before this feature shipped upgrades *in place* on its next `fetch` run — no migration script, no separate version bump.

Also worth noticing: `notification_id` is the *rowid* of the vec0 table and a logical (unenforced) reference to `agent_notifications.id`. The word "logical" matters — `vec0` doesn't support `FOREIGN KEY`. The tutorial doesn't delete notifications, so the dangling-reference case never arises, but the unenforced relationship is something a reader should know.

**Check-in question:** if you wanted to enforce that no row in `agent_embeddings` exists without a matching `agent_notifications` row, what would you do, and why doesn't this spec do it?

<details>
<summary>Expected reasoning</summary>

The natural answer is a `FOREIGN KEY` with `ON DELETE CASCADE` — but `vec0` doesn't support `FOREIGN KEY`. The next-best is a manual check inside `insertEmbedding`: `SELECT 1 FROM agent_notifications WHERE id = ?` before the insert. But this spec doesn't do that because: (a) the tutorial never deletes notifications, so the dangling case can't occur; (b) every extra check is a check that the test suite has to cover, and the simplest correct invariant ("no DELETE statements anywhere") is enforced by absence of code, not by code. For a tutorial that's the right trade-off.

</details>

---

## Lesson 4 — The embed module

`src/embed/titan.ts` is shaped exactly like `src/format/bedrock.ts`. Not an accident — it's the principle: same retry policy, same exception-to-actionable-message mapping, same shape of factory.

```typescript
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export function createTitanEmbedder(options: {
  client: BedrockRuntimeClient;
  region: string;
}): Embedder;
```

Two design choices deserve attention:

**1. `InvokeModel`, not `Converse`.** Bedrock's chat-shaped models (Claude, GLM, etc.) use `Converse` — a structured chat API. Titan's embedding API uses `InvokeModel` — a plain request/response body. The chat-side abstraction (`src/format/families.ts`) exists because the *chat* model is swappable across providers; the embedding model is not. One model, one code path, no family-resolution branching. If you find yourself adding a model-resolution switch to `titan.ts`, you've made the wrong design decision.

**2. The embedding model id is not configurable.** Fixed at `amazon.titan-embed-text-v2:0`. Configurability would mean re-embedding the entire corpus on every model change — a migration problem this tutorial doesn't need to teach. The RAG doc calls this out by name in its "Out of scope" section.

`src/embed/local.ts` exists alongside it — a no-op embedder that returns a deterministic placeholder vector. It exists for the same reason `LocalTemplateFormatter` exists in `src/format/local.ts`: so the Phase 1 (no-AWS) path type-checks against the same `Embedder` interface.

**Check-in question:** the spec says "one retry on `ThrottlingException`/5xx with the same fixed ~500ms backoff." Why *fixed* backoff, and not exponential?

<details>
<summary>Expected reasoning</summary>

If Titan is having a sustained outage, exponential backoff just delays the inevitable second failure — and during that delay, the per-source `try/catch` can't record the error. Fixed backoff means: try once, wait 500ms, try once more, fail fast and isolate. The notification posts anyway; the embedding step fails; the corpus misses one entry for tomorrow. That's the right trade-off for a per-source-per-day workload. Exponential backoff is the right choice when you have a *queue* of work that can be retried later; this tutorial has neither.

</details>

---

## Lesson 5 — The similarity module

`src/rag/similarity.ts` exports two functions. The interesting one is `findNearestMatch`:

```typescript
export function findNearestMatch(
  db: Database.Database,
  queryVector: number[],
): NearestMatch | null;
```

Note what's *not* a parameter: `source`. The match is global across every source, not scoped to the tick's own sources. The body runs:

```sql
SELECT n.id, n.base_message, n.posted_at, e.distance
FROM agent_embeddings e
JOIN agent_notifications n ON n.id = e.notification_id
WHERE e.embedding MATCH ? AND k = 50
  AND n.base_message IS NOT NULL
ORDER BY e.distance;
```

...and returns the closest row, or `null` if nothing survives (no history yet, or every candidate predates the `base_message` column and is filtered out by the `IS NOT NULL` guard).

Three things to internalize:

**A. `k = 50` is a fixed constant.** The doc is explicit: this is a known ceiling, not engineered for arbitrary scale. At the loop's 5-minute cadence (2 sources, 1 row per source per tick), 50 candidates is roughly two hours of wall-clock history — generous for this tutorial's short-lived intended test runs (5–10 minutes), but a real ceiling if the loop runs for days. Past it, `findNearestMatch` can miss the true nearest neighbor if it isn't among the 50 closest.

**B. There is no per-source filter, in SQL or in app code.** The match is "the most similar past tick," full stop — a crypto tick can match a weather tick's phrasing. This is *not* an oversight, it's the design: same-source matching would need a partition key, which `sqlite-vec` supports but this tutorial doesn't wire up (would need a migration + backfill for a scale this tutorial never reaches).

**C. Query and store now use the same text.** Both the search vector and the stored vector come from `preMessage` (Lesson 2) — there is no raw-value-vs-formatted-message asymmetry anymore. `WHERE n.base_message IS NOT NULL` exists purely so pre-migration rows (from before `base_message` was added) don't surface as candidates whose joined text is `NULL`.

There's also `insertEmbedding` — straightforward, takes a notification id and a vector, writes the row. Nothing in this module validates the vector's dimension; that's enforced at the embed layer (Titan returns 256-dim vectors for the configured model).

**Check-in question:** imagine the loop has been running unattended for a week and a real outage is happening because matches are missing. What's the smallest change you'd make, and what's the bigger architectural change that would actually fix it permanently?

<details>
<summary>Expected reasoning</summary>

Smallest change: bump `k` from 50 to something larger (e.g. 2000, roughly a week of 5-minute ticks) in `findNearestMatch`. That's a one-line change, but it doesn't scale indefinitely — it just buys headroom.

Permanent fix, if same-source matching is ever wanted: move a source filter into the vector query itself, using `sqlite-vec`'s partition-key columns. That requires a migration (a new column on `agent_embeddings`, a backfill of partition keys for existing rows, and a switch in the query). The current design leaves this out of scope because global matching across sources is the deliberate choice, not a stopgap.

</details>

---

## Lesson 6 — The suffix is mechanical, not model-driven

An earlier design considered folding the match into the LLM's prompt — "here's what you said last time, mention it if relevant." The shipped design doesn't do that. `MessageFormatter.format(ctx: LoopContext)` (`src/format/types.ts`) takes no match parameter at all, and `SYSTEM_PROMPT` in `src/format/bedrock.ts` says nothing about history. The model formats `readings` and nothing else.

The suffix is built entirely *after* the Converse call returns, in `src/agent/fetch.ts`'s `buildFinalMessageForDiscord`:

```typescript
function buildFinalMessageForDiscord(
  preMessage: string,
  baseMessage: string | null,   // match?.baseMessage, or null
  limit = 2000,
): string
```

If `baseMessage` is non-null, it appends `"\n\nReminds me of: <baseMessage>"` — clipped if necessary to respect Discord's 2000-character cap, omitted entirely if there's no room even for the separator. This is string concatenation, not a prompt engineering technique.

Three things to internalize:

**1. No second Bedrock call, and no first one either that knows about history.** The marginal cost of "mention the past" is one extra Titan call (already counted in Lesson 2) — not a second Converse invocation, and not extra tokens in the chat prompt. The chat model is completely unaware RAG exists.

**2. Testability, not flakiness.** Because the suffix is mechanical, the test suite can assert the exact output byte-for-byte: given a `preMessage` and a `baseMessage`, `buildFinalMessageForDiscord` returns exactly one string. No LLM-generated text ever needs to be asserted against — `tests/fetch.test.ts` covers `buildFinalMessageForDiscord` as pure unit tests with hardcoded inputs.

**3. This also solves the snowball problem.** The suffix quotes `base_message`, never `formatted_message` — see Lesson 3 and [08-rag-vector-search.md](08-rag-vector-search.md). Had the model been asked to "mention" the match inside its own output, that output (now containing a nested quote) would become tomorrow's `base_message`, and the chain would grow every tick it got matched again.

**Check-in question:** what would go wrong if `buildFinalMessageForDiscord` built its suffix from `match.formattedMessage` instead of `match.baseMessage`?

<details>
<summary>Expected reasoning</summary>

`formattedMessage` is the *already-suffixed* text that was actually posted — if tick N matched tick N-1, tick N's `formatted_message` already contains `"Reminds me of: <tick N-2's text>"`. Using `formattedMessage` for tick N+1's suffix would nest that whole string inside a new `"Reminds me of: ..."` wrapper, and the pattern repeats: each match quotes everything before it, unbounded, until `buildFinalMessageForDiscord`'s own clipping logic mangles it mid-sentence to fit under 2000 characters. Using `base_message` — the LLM's own pre-suffix output — means every quoted match is exactly one tick's worth of text, no matter how many times it's been matched before.

</details>

---

## Lesson 7 — Error isolation

The lesson I think is the most important for a tutorial reader, because the principle generalizes far beyond this feature.

`runFetch` in `src/agent/fetch.ts` has per-source `try/catch` around each source's *fetch* call, but RAG's failure points are tick-level, not per-source — there's one format call and one embed/match lookup for the whole tick, not one per source:

- The embed-plus-match step (`preVector = embedder.embed(preMessage)` then `findNearestMatch(db, preVector)`) is wrapped in one `try/catch` for the whole tick.
- The per-source *store* step (`insertEmbedding`, inside the per-source write loop) has its own `try/catch`, isolated per source.

The behavior, in plain English:

> A failure in the embed-or-match step:
> - Is appended to `errors[]` and folds into `agent_runs.error`.
> - Leaves `preVector` (and therefore `match`) as `null` for the rest of the tick.
> - Never blocks the Discord post — the tick posts `preMessage` with no suffix.
>
> A failure in a per-source `insertEmbedding` call:
> - Is appended to `errors[]` for that source specifically.
> - Does not affect the `agent_notifications` row already committed for that source, or any other source's embedding insert.

If the embed-or-match step fails, every source in that tick gets `nearest_match_id = NULL` and no suffix — identical downstream behavior to "no history yet." If a store-side insert fails for one source (after the notification already posted and its row already committed), only that source's entry is missing from `agent_embeddings` — it won't be a candidate for a future match, but nothing about today's post is affected.

This is the same isolation principle the base spec documents in [03-schema.md](03-schema.md), scoped to where RAG's actual boundaries are: once per tick for embed/match, once per source for the embedding insert. If you find yourself writing special-case error handling for RAG failures beyond these two `try/catch` blocks, you've broken the principle.

**Check-in question:** walk me through what `agent_runs.error` would look like in a `fetch` tick where the Titan embed call timed out.

<details>
<summary>Expected reasoning</summary>

One error entry — `rag: <timeout message>` — appended once for the whole tick, not once per source, because the embed-or-match step runs once per tick. `match` stays `null`. Every source's `agent_notifications` row for this tick gets `nearest_match_id = NULL`, `nearest_match_distance = NULL`, and no `insertEmbedding` calls happen at all (since there's no `preVector` to store) — that's a difference from a per-source store failure, which still tries to insert for sources whose own step didn't fail. The Discord post still happens, with no "Reminds me of" suffix. The point: a Titan outage degrades this tick to "no similarity mentioned," full stop, for every source at once.

</details>

---

## Lesson 8 — The status endpoint

`NotificationStatus` gains one optional field:

```typescript
export interface NotificationStatus {
  source: string;
  value: string;
  formattedMessage: string;
  postedAt: number;
  nearestMatch: {
    source: string;
    formattedMessage: string;
    postedAt: number;
    distance: number;
  } | null;
}
```

The SQL change in `queryStatus`:

```sql
-- Existing query, extended with a self-LEFT-JOIN:
SELECT
  agent_notifications.*,
  matched.source           AS matched_source,
  matched.formatted_message AS matched_formatted_message,
  matched.posted_at        AS matched_posted_at,
  agent_notifications.nearest_match_distance
FROM agent_notifications
LEFT JOIN agent_notifications AS matched
  ON matched.id = agent_notifications.nearest_match_id
ORDER BY posted_at DESC
LIMIT 10;
```

Read that carefully. It's a **self-join on the same table**, aliasing it as `matched` to pull the matched notification's own source/message/date alongside the current one.

Three things to internalize:

**1. The reader does no vector work.** It is a `LEFT JOIN` on plain columns. It does not call `sqlite-vec`. It does not query `agent_embeddings`. The status endpoint is *showing what the writer already stored*, not recomputing anything. That's why `agent_notifications` carries `nearest_match_id` and `nearest_match_distance` as plain columns in the first place — to keep the reader's work O(rows) and SQL-pure.

**1a. A subtlety worth naming: `nearestMatch.formattedMessage` is the matched tick's *posted* text, suffix included — not the `base_message` that tick actually used to build its own suffix.** The writer's suffix-building step (Lesson 6) always reads `base_message`, but the reader's join reads `formatted_message` for the matched row, because that's the human-readable text a status consumer wants to see (the same text that appeared in Discord). If you're comparing what the channel showed against what the JSON shows for a matched notification, expect them to differ by exactly one suffix.

**2. `nearestMatch: null` covers two distinct cases.** "First observation for this source" and "the embedding step failed and was isolated" — the status endpoint doesn't distinguish them, and *neither has a match to show*. From the reader's point of view they're identical: no past notification exists for this notification to reference. The doc actively prevents you from adding "smart" handling that would make the reader's code more complex for no observable benefit.

**3. Cost class is the same as the existing query.** One additional `LEFT JOIN` on an already-open handle. No new I/O, no new extension load, no new SDK call. The reader's startup cost is unchanged (still just `openReadOnlyDatabase`, which doesn't load `sqlite-vec`).

**Check-in question:** why is the join done in the `status` query rather than by `findNearestMatch` on demand from the reader?

<details>
<summary>Expected reasoning</summary>

Recall Lesson 1's constraint: the reader stays read-only and simple. If the reader called `findNearestMatch`, it would need to (a) load the `sqlite-vec` extension, (b) call Titan to embed the query, and (c) carry IAM permissions for both. All of which it currently lacks by design. By storing the match id and distance on the notification row at write time, the reader just needs `GetObject` on the SQLite file and a SQL join — no extensions, no Bedrock, no extra IAM. The writer's extra work at insert time is the price of keeping the reader small.

</details>

---

## Lesson 9 — Infrastructure

`infra/stack.ts`'s existing `bedrockPolicy` has:

```typescript
actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
resources: [/* chat model ARNs from buildBedrockResources */],
```

The RAG extension adds one more ARN to `resources`:

```
arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0
```

That's it. **No new action.** `bedrock:InvokeModel` is already in the policy's `actions` list because the chat model's non-Converse-capable families need it. The Titan embedding API also uses `InvokeModel`, so no new IAM action is required — only the new resource ARN.

This is also why the new ARN is added **directly**, not through `buildBedrockResources`:

```typescript
resources: [
  ...buildBedrockResources(/* chat model family */),
  `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
],
```

`buildBedrockResources` exists specifically to resolve the *configurable* chat model's family — it walks `families.ts` and emits the right ARN shape for the chosen provider. The embedding model is fixed (Lesson 4), so it needs no resolution branch. If you routed the Titan ARN through `buildBedrockResources`, you'd be claiming configurability the spec explicitly rules out.

**Check-in question:** if you decided tomorrow to switch the embedding model to Cohere, would you need to change the IAM, the embed module, or both? Walk me through it.

<details>
<summary>Expected reasoning</summary>

Both, because this design treats the embedding model as **fixed** and the chat model as **configurable**. To switch to Cohere you'd:

1. **IAM:** replace the Titan ARN with the Cohere embedding model ARN. (If Cohere embeddings also use `bedrock:InvokeModel`, no new IAM action; if they use a different action, add that action.)
2. **Embed module:** rewrite `createTitanEmbedder` (or add a sibling factory) to call Cohere's API instead of Titan's — different request body shape, different response shape, possibly different SDK. The `Embedder` interface stays the same so `findNearestMatch` and `fetch.ts` don't change.

This is exactly the asymmetry the design is built around. The chat model is swappable across providers, so the chat-side abstraction (`families.ts`, `buildBedrockResources`) absorbs that complexity. The embedding model is fixed, so the embedding side has no analogous abstraction — and the RAG doc calls this out by name in its "Out of scope" section.

</details>

---

## Lesson 10 — Tests + docs

The test suite mirrors existing conventions:

- **`tests/titan.test.ts`** — mirrors `tests/bedrock.test.ts`: successful embed, throttle-then-retry-succeeds, retry-exhausted-throws, access-denied error mapping. Same `aws-sdk-client-mock` pattern.
- **`tests/similarity.test.ts`** — in-memory `better-sqlite3` DB with the extension loaded: insert + KNN retrieval, matching *across* sources (a crypto embedding can match a weather query — global KNN, no per-source filter, asserted explicitly since it's easy to assume otherwise), `null` return when there's no history yet, the `k`-ceiling behavior documented as a passing case (not a bug) when exercised directly.
- **`tests/fetch.test.ts`** — extended with cases for: embed/match failure isolated into `agent_runs.error` without blocking the post; `nearest_match_id`/`nearest_match_distance` populated correctly when a match exists; both columns `NULL` on a source's first-ever notification.
- **`tests/status.test.ts`** — extended for `nearestMatch` populated via the join, and `null` in both the no-match and match-omitted-due-to-failure cases.

The interesting test design choice is in `tests/similarity.test.ts`: the `k`-ceiling behavior is asserted as a **passing case**, not a bug. Unusual in test suites — most tests assert what the code *should* do. This one asserts what the code *is documented to do*, including its limits. Deliberate teaching choice: it forces anyone reading the test to see the limit (and the doc comment it links to) instead of "fixing" it later by raising `k` without understanding the trade-off.

The doc side: `docs/08-rag-vector-search.md` follows the existing numbered-doc convention. It covers: what `sqlite-vec` is, why one table across all sources with no per-source filter, why `base_message` is a separate column from `formatted_message` (the snowball reason from Lesson 6), and the `k = 50` ceiling. `docs/01-architecture.md`'s "Bedrock calls" section covers the two-call-per-tick shape (one Converse, one Titan) alongside the base rehydration pattern.

## Verify it works

End the lesson by running, from the repo root, with the student watching:

```bash
npm test
```

Expected output: a clean pass — every test file green, every test green, no skipped or timed-out tests. The exact file/test counts and the duration will drift as the suite grows; treat those numbers as approximate and read the live output for today's truth.

If you see anything else — a failure, a timeout, a skipped test — stop and walk through which lesson it relates to before continuing. The test suite is the lesson's proof of correctness; the lesson's reasoning is the test suite's proof of intent. Both have to hold.

---

## Recap — what the student should now be able to do

Open any of these without referring back to the spec and explain it:

1. The asymmetry. Writer does the vector work; reader reads plain columns.
2. The choreography. No dedup — every tick posts. One format call, one embed call, per tick (not per source): the embed vector is computed once and reused for both search and store. Insert happens per source, sharing that tick's one match.
3. The data model. One `vec0` table across all sources, 256 dims, three nullable columns (including `base_message`), `ALTER TABLE`-in-`bootstrap()` for in-place upgrades.
4. The embed module. `InvokeModel` not `Converse`, fixed model id, retry policy mirrors the chat module.
5. The similarity module. KNN of 50 (≈2 hours at 5-min cadence), no source filter anywhere (global match by design), query and store both embed the same text (`preMessage`/`base_message`) — no raw-vs-formatted asymmetry anymore.
6. The suffix. Built mechanically in `buildFinalMessageForDiscord`, after the Converse call, from `base_message` never `formatted_message` — the LLM never sees or influences it. This is also what prevents the suffix from snowballing.
7. Error isolation. Embed-and-match is one tick-level failure point; the per-source embedding insert is its own. Today's post is unaffected either way; a failure just means tomorrow's lookup may miss an entry.
8. Status endpoint. Self-`LEFT JOIN` on plain columns. Reader does no vector work. The matched text shown is `formatted_message` (posted text, suffix included), not `base_message`.
9. Infra. One new resource ARN, no new IAM action, not routed through `buildBedrockResources` because the embedding model isn't swappable.
10. Tests + docs. The `k`-ceiling is asserted as a passing case, deliberately; cross-source matching is asserted explicitly rather than assumed away.

If any of those feels thin to the student when they try to reproduce the reasoning, drill back into the corresponding lesson before declaring the session done.
