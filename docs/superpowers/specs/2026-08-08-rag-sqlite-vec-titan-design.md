# RAG via sqlite-vec + Titan Embeddings — Design

**Date:** 2026-08-08
**Status:** Implemented
**Scope:** Extends the existing SQLite-S3 agent tutorial to demonstrate that the same single SQLite file can also serve as a vector store — no separate vector database needed. The agent embeds each notification it posts and, on the next new value for that source, mentions the most similar past result.

---

## 1. Purpose and constraints

The base tutorial ([2026-08-08-sqlite-s3-agent-tutorial-design.md](2026-08-08-sqlite-s3-agent-tutorial-design.md)) teaches "SQLite file in S3 replaces a database server." This extension teaches a second substitution: "SQLite with the `sqlite-vec` extension replaces a vector database." The demonstration is intentionally small — one KNN lookup, one extra line in an LLM prompt — because the pattern, not the scale, is the point.

**Constraints carried over from the base spec:** standalone, TypeScript/Node 24/ESM, public-tutorial quality (every non-obvious decision explained in `docs/`), no VPC/DB server, single-writer invariant, single-user.

**New constraint this feature must respect:** the reader (`status` op) stays read-only and simple. It must not load `sqlite-vec` or run vector queries — it only ever displays what the writer already computed and stored in plain columns. This preserves the base spec's reader/writer asymmetry (reader has `GetObject`-only IAM, no reason to carry vector-search capability it never uses for writes).

---

## 2. Architecture

No new infrastructure. `agent_embeddings`, a `sqlite-vec` `vec0` virtual table, joins the existing three tables inside the same `memory.db` file that already round-trips through S3. One new outbound call per posted notification, to Amazon Titan Text Embeddings V2 via Bedrock, alongside the existing Converse call to the formatting model.

```
runFetch, per source (existing loop in src/agent/fetch.ts):

  rawValue = fetch()
  if rawValue === lastValue: continue                    # unchanged, same as today

  queryVector = titanEmbed(rawValue)                      # new
  match = findNearestMatch(db, source, queryVector)       # new — null if no history yet

  formatted = bedrockFormat(source, rawValue, match)       # match folded into the prompt
  post(formatted)

  notificationId = INSERT agent_notifications (
    ..., nearest_match_id, nearest_match_distance          # new columns, from match
  )

  storeVector = titanEmbed(formatted)                      # new
  INSERT agent_embeddings (notification_id, storeVector)   # new
```

The embedding calls sit in the same per-source error boundary the writer already has for fetch/format/post failures (§6). A `status` call never touches `agent_embeddings` — it reads `nearest_match_id`/`nearest_match_distance` off `agent_notifications` like any other column.

---

## 3. Data model

### 3.1 New virtual table

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS agent_embeddings USING vec0(
  notification_id INTEGER PRIMARY KEY,
  embedding        FLOAT[256] distance_metric=cosine
);
```

One table, not one per source. Sources are a closed vocabulary maintained in exactly one place (`SOURCE_NAMES` in `src/db/schema.ts`, per [docs/04-extending.md](../../04-extending.md)); a per-source vector table would break that invariant by requiring a schema edit *and* a new virtual table for every added source. Same-source filtering happens in application code instead (§4.2).

`notification_id` is `agent_embeddings`'s rowid and a logical (unenforced — `vec0` doesn't support `FOREIGN KEY`) reference to `agent_notifications.id`. Every row in `agent_embeddings` corresponds to exactly one posted notification; rows are never written for deduped (unchanged) values, matching the base spec's "the model is paid for only when there's something new to say" principle (§3.1 step 5c of the base spec) — now extended to the embedding calls too.

256 dimensions: Titan Text Embeddings V2 supports 256/512/1024, and is explicitly tuned to keep good retrieval quality at 256. A tutorial's corpus (a handful of rows per source, growing by at most a few a day) doesn't need 1024's fidelity, and smaller vectors keep the demo's storage and query cost visibly small.

### 3.2 New columns on `agent_notifications`

```sql
ALTER TABLE agent_notifications ADD COLUMN nearest_match_id INTEGER REFERENCES agent_notifications(id);
ALTER TABLE agent_notifications ADD COLUMN nearest_match_distance REAL;
```

Both nullable: `NULL` means "no past notification existed for this source yet" (first-ever observation) or "the embedding/search step failed and was isolated" (§6) — either way, "nothing to mention" is the correct downstream behavior for both the prompt and the status endpoint. Written once, at insert time, by `runFetch` — never updated afterward. This mirrors why `agent_runs.outcome`/`error` are nullable in the base schema (`docs/03-schema.md`): absence of a value is itself meaningful, not a placeholder to special-case.

`AGENT_DDL` in `src/db/schema.ts` uses `CREATE TABLE IF NOT EXISTS`, so these columns are added via a second idempotent statement in `bootstrap()` (`ALTER TABLE ... ADD COLUMN` guarded by a `PRAGMA table_info` check, since SQLite has no `ADD COLUMN IF NOT EXISTS`) rather than folded into the `CREATE TABLE`, so that a database bootstrapped before this feature shipped upgrades in place on its next `fetch` run.

---

## 4. New modules

### 4.1 `src/embed/titan.ts`

```typescript
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export function createTitanEmbedder(options: {
  client: BedrockRuntimeClient;
  region: string;
}): Embedder;
```

Shape mirrors `src/format/bedrock.ts`: one retry on `ThrottlingException`/5xx with the same fixed ~500ms backoff, the same SDK-exception-to-actionable-message mapping (access denied → "enable model access," etc.). Calls `InvokeModelCommand` (Titan's embedding API is `InvokeModel`, not `Converse` — Converse is for chat-turn models) against the fixed model id `amazon.titan-embed-text-v2:0` with body `{ inputText: text, dimensions: 256, normalize: true }`. Unlike `bedrockModelId`, the embedding model id is not configurable — one model, one code path, no family-resolution branching (`src/format/families.ts`'s multi-family logic exists because the *chat* model is swappable across providers; nothing here needs that).

### 4.2 `src/rag/similarity.ts`

```typescript
export interface NearestMatch {
  notificationId: number;
  distance: number;
  formattedMessage: string;
  postedAt: number;
}

export function findNearestMatch(
  db: Database.Database,
  source: SourceName,
  queryVector: number[],
): NearestMatch | null;

export function insertEmbedding(
  db: Database.Database,
  notificationId: number,
  vector: number[],
): void;
```

`findNearestMatch` runs a `k = 50` KNN query against `agent_embeddings` (`WHERE embedding MATCH ? AND k = 50`), joins to `agent_notifications`, filters to the requested `source`, and returns the closest row (or `null` if the source has no prior rows at all, or none survive the filter). `k = 50` is a fixed constant, the same kind of explicit ceiling as `RECENT_NOTIFICATIONS_LIMIT = 10` in `src/agent/status.ts` — generous for a once-daily tutorial (50 rows is ~7 weeks of history across two sources), and documented here as a known limit rather than engineered for arbitrary scale: past that ceiling, `findNearestMatch` can miss the true nearest same-source neighbor. That trade-off is acceptable for a tutorial; a production system with real growth would raise `k` or move the source filter into the vector query itself once `sqlite-vec`'s partition-key support is verified stable enough to depend on.

### 4.3 `src/format/bedrock.ts` — extended, not replaced

`format()` gains an optional third parameter:

```typescript
format(source: SourceName, rawValue: string, nearestMatch?: NearestMatch | null): Promise<string>
```

When `nearestMatch` is present, `buildUserPrompt` appends one line:

```
Closest past reading (<ISO date from postedAt>): "<formattedMessage>"
```

`SYSTEM_PROMPT` gains one sentence telling the model it may naturally reference this line if relevant, without being required to. No second Bedrock call — this rides the same Converse request that already formats today's value. `LocalTemplateFormatter` (`src/format/local.ts`) accepts and ignores the parameter, consistent with how it already exists purely so the Phase 1 (no-AWS) path type-checks against the same interface.

---

## 5. `db/open.ts` and `db/bootstrap.ts` changes

`openDatabase` (writer only — `openReadOnlyDatabase` is untouched) opens with `{ allowExtension: true }` and calls `db.loadExtension(require.resolve('sqlite-vec'))` immediately after opening, before `bootstrap()` runs — `bootstrap`'s DDL includes `CREATE VIRTUAL TABLE ... USING vec0`, which fails if the extension isn't loaded yet. The reader never loads the extension: it has no vector queries to run, only plain-column reads of `nearest_match_id`/`nearest_match_distance`.

`sqlite-vec` ships as a prebuilt native loadable extension per platform (npm package `sqlite-vec`), the same distribution model `better-sqlite3` already uses. The existing Dockerfile builds both stages for `arm64` (matching the Lambda architecture) — no new build step is conceptually required, but the implementation plan must verify the npm package publishes an arm64 Linux binary compatible with the `node:24-bookworm-slim` runtime image before this is considered done; a mismatch here would only surface at cold start in AWS, not in local dev on a different host architecture.

---

## 6. Error handling

The Titan query-embed call, the `findNearestMatch` lookup, and the Titan store-embed + `insertEmbedding` call are each wrapped in the *same* per-source `try/catch` `runFetch` already has for fetch/format/post failures (`src/agent/fetch.ts`, current lines 68–106). A failure at any of these steps:

- Is appended to `errors[]` and folds into `agent_runs.error`, exactly like an existing per-source failure.
- Does **not** abort the source's notification: if the query-embed or match step fails, `runFetch` proceeds with `match = null` (identical downstream behavior to "no history yet" — the prompt has no similarity line, `nearest_match_id`/`nearest_match_distance` are `NULL`). If the store-embed step fails (after the notification already posted), the notification and its row still commit; only the corpus fails to grow by one entry for future lookups.
- Never blocks the Discord post itself. RAG is additive to the existing notification flow, not a precondition for it — a Titan outage degrades this feature to "no similarity mentioned today," not "no notifications posted today."

This is a direct extension of the isolation model documented in `docs/03-schema.md` and the `runFetch` docstring (`src/agent/fetch.ts` lines 34–39) — one more category of per-source failure, not a new failure-handling design.

---

## 7. Status endpoint

`NotificationStatus` (`src/agent/status.ts`) gains one optional field:

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

`queryStatus`'s existing notifications query gains a `LEFT JOIN agent_notifications AS matched ON matched.id = agent_notifications.nearest_match_id`, pulling `matched.source`, `matched.formatted_message`, `matched.posted_at` alongside the existing columns, plus the stored `agent_notifications.nearest_match_distance`. No vector search happens at read time — this is a second `LEFT JOIN` on an already-open handle, same cost class as the existing single-table query. `nearestMatch: null` covers both "first observation for this source" and "the embedding step failed" (§6) — the status endpoint doesn't distinguish them, since neither has a match to show.

---

## 8. Infra

`infra/stack.ts`'s existing `bedrockPolicy` (`actions: ['bedrock:InvokeModel', 'bedrock:Converse']`) gets one more entry in its `resources` array: `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`, added directly (not through `buildBedrockResources`, which exists specifically to resolve the *configurable* chat model's family — the embedding model is fixed, so it needs no resolution branch). `bedrock:InvokeModel` is already in the policy's `actions` list for the chat model's non-Converse-capable families, so no new action is needed, only the new resource ARN.

---

## 9. Testing

New test files, same conventions as the existing suite (`tests/*.test.ts`, `aws-sdk-client-mock` for Bedrock calls):

- **`tests/titan.test.ts`** — mirrors `tests/bedrock.test.ts`: successful embed, throttle-then-retry-succeeds, retry-exhausted-throws, access-denied error mapping.
- **`tests/similarity.test.ts`** — in-memory `better-sqlite3` DB with the extension loaded: insert + KNN retrieval, same-source filtering (a crypto embedding never matches a weather query), `null` return when the source has no rows yet, `k`-ceiling behavior documented as a passing case (not a bug) when exercised directly.
- **`tests/fetch.test.ts`** — extended with cases for: embed/match failure isolated into `agent_runs.error` without blocking the post (§6); `nearest_match_id`/`nearest_match_distance` populated correctly when a match exists; both columns `NULL` on a source's first-ever notification.
- **`tests/status.test.ts`** — extended for `nearestMatch` populated via the join, and `null` in both the no-match and match-omitted-due-to-failure cases.

---

## 10. Documentation

New `docs/07-rag-vector-search.md`, following the existing numbered-doc convention (`01-architecture.md` … `06-discord-webhook-setup.md`): what `sqlite-vec` is, why `agent_embeddings` is one table instead of one per source, why the query embedding uses `rawValue` while the stored embedding uses `formatted_message` (the chicken-and-egg reason — `formatted_message` doesn't exist until *after* the value being searched for has been formatted), and the `k = 50` ceiling. `docs/01-architecture.md`'s diagram gains the Titan embedding calls alongside the existing Bedrock Converse call.

---

## 11. Out of scope

- **Cross-source similarity search.** Same-source only, per §4.2 — a "closest crypto price to today's weather" comparison isn't semantically meaningful for this tutorial's two sources.
- **Configurable embedding model or dimension count.** Fixed at Titan v2 / 256 dims, same reasoning as fixing the model id in §4.1 — configurability here would mean re-embedding the whole corpus on every change, a migration problem this tutorial doesn't need to teach.
- **`sqlite-vec` partition-key columns for source-scoped KNN at the SQL level.** Noted in §4.2 as a future option once verified stable; the app-level filter is simpler to explain and sufficient at this corpus size.
- **Backfilling embeddings for notifications posted before this feature shipped.** Existing `agent_notifications` rows simply never appear as a `nearest_match` candidate; the corpus starts growing from the first `fetch` run after this feature deploys.
- **Similarity threshold / "don't mention if too dissimilar."** Every match found within `k = 50` for the source is used, regardless of distance — keeps the demo mechanical and simple to test; a threshold is a tuning knob a real product would want, not something this tutorial needs to teach.
