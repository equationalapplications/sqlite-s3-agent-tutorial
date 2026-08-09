# Lesson Script — RAG via `sqlite-vec` + Titan Embeddings

**Audience:** a teacher walking a student through the RAG extension.
**Length:** 10 lessons, roughly 30 minutes including the closing test run.
**Prerequisite:** the student has read [08-rag-vector-search.md](08-rag-vector-search.md) and the base tutorial's [01-architecture.md](01-architecture.md). Familiarity with the writer/reader asymmetry in [01-architecture.md](01-architecture.md) and the per-source error isolation in [03-schema.md](03-schema.md) is assumed.

## How to use this script

Each lesson opens with the *frame* (what concept you're trying to land) and closes with a *check-in question* — the kind you'd ask out loud, not as a written quiz. The expected reasoning for each question is given in a collapsed detail block so the teacher can read it before class but the student can't see it during the lesson.

End the session by running `npm test` from the repo root with the student watching. The expected output — **110 tests across 14 files pass in ~6.5 seconds** — is the proof that the lesson landed.

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

The choreography. Per source, per `fetch` run:

```
rawValue = fetch()
if rawValue === lastValue: continue                  # unchanged, dedup still rules

queryVector = titanEmbed(rawValue)                   # NEW (search-side embed)
match = findNearestMatch(db, source, queryVector)    # NEW (returns null if no history)

formatted = bedrockFormat(source, rawValue, match)   # match folded into prompt
post(formatted)

notificationId = INSERT agent_notifications (
  ..., nearest_match_id, nearest_match_distance      # NEW columns
)

storeVector = titanEmbed(formatted)                  # NEW (store-side embed)
INSERT agent_embeddings (notification_id, storeVector)  # NEW
```

Read this slowly. Three properties to land:

1. **The dedup check still comes first.** Unchanged values never reach the embedding calls. The model — both the chat model *and* Titan — is paid for only when there's something new to say. The same invariant the base spec enforces for the LLM format call now extends to embedding calls. If you skip dedup and embed every fetch, you triple the API cost for nothing.

2. **Two Titan calls per posted notification, not one.** Search-side embeds the *raw value* (the formatted message doesn't exist yet). Store-side embeds the *formatted message* (it's richer text by the time we get there, and Titan famously embeds "a sunny 72°F afternoon" more usefully than "72F"). Both go through the same 256-dim Titan model, so they share a vector space and can be compared.

3. **The two new columns are written once, at insert time, never updated.** Just like `agent_runs.outcome`/`error` in the base schema: absence is meaningful (first observation, or the embedding step failed), not a placeholder.

The implementation lives in `src/agent/fetch.ts`.

**Check-in question:** what does "match = null" mean, and is it always the same "null"?

<details>
<summary>Expected reasoning</summary>

There are two distinct upstream causes that produce the same null:

1. The source has no prior notifications yet (first-ever observation).
2. The query-embed or match step failed and was isolated by the per-source `try/catch`.

The doc deliberately collapses both into the same null. They have identical downstream behavior: no similarity line in the prompt, both columns `NULL` in the inserted row, `nearestMatch: null` in the status endpoint. From any consumer's perspective, "nothing to mention" is the correct behavior in both cases.

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

-- 2. Two new nullable columns on the existing table
ALTER TABLE agent_notifications ADD COLUMN nearest_match_id INTEGER REFERENCES agent_notifications(id);
ALTER TABLE agent_notifications ADD COLUMN nearest_match_distance REAL;
```

Three things to internalize:

**A. One vector table across all sources.** Sources are a closed vocabulary maintained in exactly one place — `SOURCE_NAMES` in `src/db/schema.ts`. A per-source vector table would mean a second place to edit every time you add a source (a schema edit *and* a new virtual table). That breaks the invariant the base spec established in [04-extending.md](04-extending.md). Same-source filtering happens in app code instead — Lesson 5.

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

**2. The embedding model id is not configurable.** Fixed at `amazon.titan-embed-text-v2:0`. Configurability would mean re-embedding the entire corpus on every model change — a migration problem this tutorial doesn't need to teach. The doc calls this out by name in Section 11.

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
  source: SourceName,
  queryVector: number[],
): NearestMatch | null;
```

The body runs:

```sql
SELECT notification_id, distance
FROM agent_embeddings
WHERE embedding MATCH ? AND k = 50
ORDER BY distance;
```

Then it joins the result to `agent_notifications`, filters down to the requested `source`, and returns the closest survivor — or `null` if the source has no prior rows at all, or none survived the filter.

Three things to internalize:

**A. `k = 50` is a fixed constant.** The doc is explicit: this is a known ceiling, not engineered for arbitrary scale. 50 rows is ~7 weeks of history across two sources at one post per source per day. Past that ceiling, `findNearestMatch` *can* miss the true nearest same-source neighbor — because it's a KNN over *all sources*, then an app-level filter, not a source-scoped KNN. For this tutorial that's fine.

**B. The same-source filter is in app code, not SQL.** The price of "one table across all sources." The benefit: adding a new source requires editing exactly one place (`SOURCE_NAMES`). The cost: KNN scans can return up to 50 rows that get filtered away. At this corpus size, free. At a million-row corpus, you'd want partition-key support, which exists in `sqlite-vec` but the spec calls out as "noted as a future option once verified stable."

**C. The asymmetry from Lesson 2, restated.** Query-side embeds the *raw value* (chicken and egg — the formatted message doesn't exist yet). Store-side embeds the *formatted message* (it exists now and it's richer text). Both go through the same 256-dim Titan model with `normalize: true`, so they share a vector space. This works because Titan doesn't require its inputs to share a style, just a language.

There's also `insertEmbedding` — straightforward, takes a notification id and a vector, writes the row. Nothing in this module validates the vector's dimension; that's enforced at the embed layer (Titan returns 256-dim vectors for the configured model).

**Check-in question:** imagine the corpus has grown to 200 rows per source and a real production outage is happening because matches are missing. What's the smallest change you'd make, and what's the bigger architectural change that would actually fix it permanently?

<details>
<summary>Expected reasoning</summary>

Smallest change: bump `k` from 50 to 500 in `findNearestMatch`. That's a one-line change, but it doesn't scale — it just buys you time.

Permanent fix: move the same-source filter into the vector query itself, using `sqlite-vec`'s partition-key columns. That requires a migration (a new column on `agent_embeddings`, a backfill of partition keys for existing rows, and a switch in the query). The spec explicitly leaves this as "out of scope / future option" because the tutorial's corpus never hits the ceiling — and the doc tells you what the ceiling is and what to do when you hit it.

</details>

---

## Lesson 6 — `format()` extended, not replaced

The base tutorial's `format()` signature was:

```typescript
format(source: SourceName, rawValue: string): Promise<string>
```

The RAG extension makes it:

```typescript
format(source: SourceName, rawValue: string, nearestMatch?: NearestMatch | null): Promise<string>
```

When `nearestMatch` is present, `buildUserPrompt` appends exactly one line:

```
Closest past reading (<ISO date from postedAt>): "<formattedMessage>"
```

And `SYSTEM_PROMPT` gains one sentence telling the model it *may* naturally reference the line if relevant, without being required to.

Three things to internalize:

**1. No second Bedrock call.** This rides the same Converse request that already formats today's value. The marginal cost of "mention the past" is a few extra tokens in the prompt — not a second model invocation. Deliberate: the tutorial is teaching the *vector* piece, not the *multi-turn* piece. If you wanted multi-turn ("the model calls a tool, retrieves a match, decides whether to mention"), you'd be teaching agents, not RAG.

**2. The model is told it *may*, not *must*.** Important for testability. If the model were told it *must* reference the match, the test suite would have to assert on LLM-generated text — flaky. With "may reference," the test suite can assert that the prompt *contains* the line and that the formatted message *can* be produced — but never has to assert that the model actually wrote "last Tuesday's reading!" in its output. The unit of behavior under test is "did the prompt get built correctly," not "did the LLM do something specific with the prompt."

**3. `LocalTemplateFormatter` accepts and ignores.** Same pattern as the Phase 1 no-AWS path: it accepts the new parameter to keep the interface consistent, but it doesn't use it. Load-bearing pattern: type compatibility across all formatters, real behavior on whichever one is wired up.

**Check-in question:** why is the match appended to the *user* prompt (with the formatted message text), not just stashed somewhere the model can find it later?

<details>
<summary>Expected reasoning</summary>

Chat models attend to everything in the context window, but they attend *most strongly* to recent and explicit content. Stuffing the match into the system prompt dilutes it with the persona/role instructions; putting it into a tool result or a separate channel doesn't exist in Converse's simple request shape; embedding it directly into the user prompt alongside today's value gives it the best chance of being referenced naturally. The cost is a few extra tokens in the prompt, which is negligible against the model context.

</details>

---

## Lesson 7 — Error isolation

The lesson I think is the most important for a tutorial reader, because the principle generalizes far beyond this feature.

`runFetch` in `src/agent/fetch.ts` already has a per-source `try/catch` covering fetch, format, and post failures. The RAG extension adds *three* more failure points inside that same `try/catch`:

- Query-side Titan embed call
- `findNearestMatch` lookup
- Store-side Titan embed + `insertEmbedding` call

The behavior, in plain English:

> A failure at any of these steps:
> - Is appended to `errors[]` and folds into `agent_runs.error`, exactly like an existing per-source failure.
> - Does **not** abort the source's notification.
> - Never blocks the Discord post.

Read the second bullet again. If the *query-embed* or *match* step fails, `runFetch` proceeds with `match = null` — identical downstream behavior to "no history yet." The prompt has no similarity line, the columns are `NULL`, the status endpoint shows `nearestMatch: null`. If the *store-embed* step fails (after the notification already posted), the notification and its row still commit — only the corpus fails to grow by one entry for future lookups.

That last case is the subtle one. The Discord post already happened. The notification already landed in `agent_notifications`. We couldn't embed it, so it won't appear as a match tomorrow. That's the entire failure mode: future lookups miss this one notification. The user-facing today experience is unaffected.

This is the same isolation model the base spec documents in [03-schema.md](03-schema.md). The RAG extension is *one more category* of per-source failure, not a new failure-handling design. If you find yourself writing special-case error handling for embedding failures, you've broken the principle.

**Check-in question:** walk me through what `agent_runs.error` would look like in a `fetch` run where the weather source's query-embed call timed out but the crypto source succeeded.

<details>
<summary>Expected reasoning</summary>

It should look exactly like a `fetch` run where weather's source API timed out but crypto succeeded: one row in `agent_runs.error` for the weather source (whichever step failed first — query-embed, in this case), one normal success row for crypto. The Discord post for weather still happens (without a similarity line, because match is null). The Discord post for crypto still happens (with its similarity line, if any). The point is: per-source isolation means a Titan outage on one source's lookup is indistinguishable from a source-API outage, in terms of how `agent_runs` records it.

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

This is exactly the asymmetry the design is built around. The chat model is swappable across providers, so the chat-side abstraction (`families.ts`, `buildBedrockResources`) absorbs that complexity. The embedding model is fixed, so the embedding side has no analogous abstraction — and the doc calls this out by name as out-of-scope (Section 11).

</details>

---

## Lesson 10 — Tests + docs

The test suite mirrors existing conventions:

- **`tests/titan.test.ts`** — mirrors `tests/bedrock.test.ts`: successful embed, throttle-then-retry-succeeds, retry-exhausted-throws, access-denied error mapping. Same `aws-sdk-client-mock` pattern.
- **`tests/similarity.test.ts`** — in-memory `better-sqlite3` DB with the extension loaded: insert + KNN retrieval, same-source filtering (a crypto embedding never matches a weather query), `null` return when the source has no rows yet, the `k`-ceiling behavior documented as a passing case (not a bug) when exercised directly.
- **`tests/fetch.test.ts`** — extended with cases for: embed/match failure isolated into `agent_runs.error` without blocking the post; `nearest_match_id`/`nearest_match_distance` populated correctly when a match exists; both columns `NULL` on a source's first-ever notification.
- **`tests/status.test.ts`** — extended for `nearestMatch` populated via the join, and `null` in both the no-match and match-omitted-due-to-failure cases.

The interesting test design choice is in `tests/similarity.test.ts`: the `k`-ceiling behavior is asserted as a **passing case**, not a bug. Unusual in test suites — most tests assert what the code *should* do. This one asserts what the code *is documented to do*, including its limits. Deliberate teaching choice: it forces anyone reading the test to see the limit (and the doc comment it links to) instead of "fixing" it later by raising `k` without understanding the trade-off.

The doc side: `docs/08-rag-vector-search.md` (note: file is `08-`, not `07-` as the original spec text suggested — `07-budget-protection.md` was added later and pushed it down) follows the existing numbered-doc convention. It covers: what `sqlite-vec` is, why one table not per-source, the raw-value-vs-formatted-message asymmetry (the chicken-and-egg reason), and the `k = 50` ceiling. `docs/01-architecture.md`'s diagram gains the Titan embedding calls alongside the existing Bedrock Converse call.

## Verify it works

End the lesson by running, from the repo root, with the student watching:

```bash
npm test
```

Expected output:

```
 Test Files  14 passed (14)
      Tests  110 passed (110)
   Duration  ~6.5s
```

If you see anything else — a failure, a timeout, a skipped test — stop and walk through which lesson it relates to before continuing. The test suite is the lesson's proof of correctness; the lesson's reasoning is the test suite's proof of intent. Both have to hold.

---

## Recap — what the student should now be able to do

Open any of these without referring back to the spec and explain it:

1. The asymmetry. Writer does the vector work; reader reads plain columns.
2. The choreography. Dedup first, then two Titan calls bracketing the format call, then insert. Three new failure points but the same per-source `try/catch`.
3. The data model. One `vec0` table across all sources, 256 dims, two nullable columns, `ALTER TABLE`-in-`bootstrap()` for in-place upgrades.
4. The embed module. `InvokeModel` not `Converse`, fixed model id, retry policy mirrors the chat module.
5. The similarity module. KNN of 50, app-level source filter, the raw-vs-formatted embedding asymmetry, the documented `k`-ceiling trade-off.
6. `format()` extension. One prompt line, one `SYSTEM_PROMPT` sentence, no second Bedrock call, model *may* not *must* reference.
7. Error isolation. RAG failures fold into the existing per-source model. Today's notification is unaffected; tomorrow's lookup may miss one entry.
8. Status endpoint. Self-`LEFT JOIN` on plain columns. Reader does no vector work.
9. Infra. One new resource ARN, no new IAM action, not routed through `buildBedrockResources` because the embedding model isn't swappable.
10. Tests + docs. The `k`-ceiling is asserted as a passing case, deliberately.

If any of those feels thin to the student when they try to reproduce the reasoning, drill back into the corresponding lesson before declaring the session done.
