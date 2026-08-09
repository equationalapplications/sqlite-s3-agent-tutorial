# Loop Mode + Poetic Closing — Design

**Date:** 2026-08-09
**Status:** Draft (pending user review)
**Scope:** Replaces the once-daily schedule with a 3-minute loop, makes the Discord message more varied and fun (date + location + weather + crypto + closest-match context, ending with a short haiku), and adds curl commands to start and stop the loop. One writer, dedup made optional via env var, no new user-facing tutorial doc.

---

## 1. Purpose and constraints

The base tutorial posts one Discord message per day, on value change only. For local testing and quick iteration, a 3-minute cadence is more useful — you can see the LLM's output in seconds, not hours — and the message should be more varied (incorporating date, location, and a creative closing) rather than the current template-y "Weather update: 72F" / "Crypto update: 67234.10".

**Constraints carried over from the base spec:** standalone, TypeScript/Node 24/ESM, public-tutorial quality, no VPC/DB server, single-writer invariant, single-user, reader stays read-only.

**New constraints this feature must respect:**

- **One writer.** The existing `runFetch` is the only writer path. No parallel `runLoopTick` that forks the semantics. Any loop-specific behavior is a small change inside `runFetch` plus a new enable/disable gate.
- **No new user-facing tutorial doc.** The base tutorial teaches the pattern, not the loop. The README gets a short "Loop mode" subsection with the curl commands; `docs/07-budget-protection.md` gets a one-paragraph note that the loop drives ~960 Bedrock calls/day. No new `docs/0X-*.md`.
- **Numerology is out.** The closing beat is a short haiku the LLM generates, not a numerology sentence. LLMs produce cliché numerology platitudes; a haiku gives them actual creative room and reads as varied across runs.

---

## 2. Architecture

The deploy changes:
- A new EventBridge schedule at `rate(3 minutes)` replaces the existing `rate(1 day)` schedule (single edit in `infra/stack.ts`).
- The schedule invokes the same Lambda with the same `{op:"fetch"}` payload. No new op for the scheduled tick.

The runtime changes:
- `runFetch` reads two new pieces of state: a `FETCH_DEDUP` env var (default `false`) and a `loop_enabled` setting in the SQLite snapshot (default `true` after first deploy, since the loop is now the primary mode). If `loop_enabled` is `'false'`, `runFetch` returns early without fetching, formatting, or posting.
- When `FETCH_DEDUP` is `false` (the default), the per-source dedup check is skipped — every tick produces one `agent_notifications` row per source and one Discord post per source. When `true`, the existing per-source value-change dedup is preserved (useful if someone wants the original daily-style low-cost behavior).
- The formatter's user prompt gains structured fields: `date`, `location`, `weatherValue`, `cryptoValue`, in addition to the existing `source` and `rawValue`. The system prompt instructs the LLM to (1) write a short friendly comment that draws on the inputs, (2) naturally reference the closest past reading if provided, and (3) end with a brief haiku (5-7-5) that incorporates the temperature, the crypto value, and the day's vibe.

The control plane changes:
- Two new ops, `loop-start` and `loop-stop`, gated by a new `LOOP_TOKEN` env var (same constant-time check pattern as `FETCH_TRIGGER_TOKEN`). They write `'true'`/`'false'` to a new `agent_settings` row, then re-publish the snapshot with the updated ETag. Default-deny if `LOOP_TOKEN` is unset.
- The status endpoint gains a `loopEnabled: boolean` field so you can see the current state via the existing `op:"status"` call.

```
EventBridge rate(3 min) ──> Lambda (op:"fetch")
                                  │
                                  ▼
                            runFetch
                              │
                              ├─ read agent_settings.loop_enabled
                              │     └─ 'false'  → return early (no fetch, no post)
                              │
                              ├─ read FETCH_DEDUP env var
                              │     └─ 'false' (default) → skip dedup check
                              │     └─ 'true'           → keep current dedup behavior
                              │
                              ├─ per-source:
                              │     fetch, findNearestMatch (RAG),
                              │     formatter.format(ctx), post to Discord,
                              │     insert agent_notifications row, embed + store
                              │
                              └─ publish snapshot to S3 (conditional)

curl "FUNCTION_URL?token=$LOOP_TOKEN" --data '{"op":"loop-stop"}'
                                       │
                                       └─ writes agent_settings.loop_enabled='false',
                                          re-publishes snapshot
```

---

## 3. Data model

### 3.1 New table: `agent_settings`

```sql
CREATE TABLE IF NOT EXISTS agent_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

One row currently: `(key='loop_enabled', value='true' | 'false')`. The shape is generic (key-value) rather than purpose-built so future settings don't require another schema edit — same pattern the base spec uses for `agent_runs.error` (nullable absence is meaningful, not a placeholder).

### 3.2 No change to existing tables

`agent_sources`, `agent_notifications`, `agent_runs`, and `agent_embeddings` are unchanged. `agent_notifications` will grow ~28,800 rows/day at 3-min cadence with `FETCH_DEDUP=false` (2 sources × 480 ticks × ~2 rows/tick counting closest-match bookkeeping), which is a known concern documented in `docs/07-budget-protection.md`. No TTL/cap is added in this scope — adding one would change the RAG "every posted message is searchable" invariant and belongs in a separate spec.

---

## 4. New / changed modules

### 4.1 `src/config.ts` — new env vars

- `FETCH_DEDUP` (string, parsed as `boolean`, default `false`): when `true`, preserves the original per-source value-change dedup; when `false` (default), `runFetch` always posts.
- `LOOP_TOKEN` (string, optional, default `null`): gates the new `loop-start` / `loop-stop` ops. Same default-deny posture as `FETCH_TRIGGER_TOKEN`.

Both reuse the existing `str` / `optionalStr` / `num` helpers — no new parser.

### 4.2 `src/format/types.ts` — new `FormatContext`

```typescript
export interface FormatContext {
  source: SourceName;
  rawValue: string;
  date: string;           // ISO date, e.g. "2026-08-09"
  location: string;       // e.g. "NYC"
  weatherValue: string;   // current weather for the location, e.g. "72F"
  cryptoValue: string;    // current BTC USD price as a string, e.g. "67234.10"
  similarPast: SimilarPastResult | null;
}

export interface MessageFormatter {
  format(ctx: FormatContext): Promise<string>;
}
```

The signature change is internal — `MessageFormatter` is a TypeScript type used only by `runFetch` and `localFetch` (and the format module's own tests); it is not a public package surface. `LocalTemplateFormatter` and `BedrockFormatter` are updated to match.

### 4.3 `src/format/bedrock.ts` — new system prompt

```
SYSTEM:
You write a short, friendly Discord message for a daily-checkin bot that
posts a weather and crypto snapshot every few minutes. The user message
below contains today's date, the location, the current weather, the current
crypto value, and (when available) the closest past reading. Write a brief
comment (one or two sentences) that draws on these inputs — vary your
phrasing across runs; do not repeat the same template. If a closest past
reading is included, you may naturally reference it, but you are not
required to. End with a short haiku (three lines, 5-7-5 syllables) that
weaves in the temperature, the crypto value, and the day's vibe. Reply
with the message text only — no quotes, no preamble, no markdown.
```

The local template formatter is updated to a minimal `{date} — {weatherValue} / {cryptoValue} / <poem placeholder>` shape so its tests still pin the new context fields. It is not expected to generate a haiku — it's a test-only stub.

### 4.4 `src/agent/fetch.ts` — loop gate + dedup toggle

- Reads `loop_enabled` from `agent_settings` at the start. If `'false'`, returns `{ outcome: 'success', sourcesChecked: 0, notificationsSent: 0, error: null }` without writing a run row, fetching, or publishing (so a stopped loop is a no-op every tick, not a record-keeping churn).
- Reads `FETCH_DEDUP` via `loadConfig`. If `false`, the per-source `rawValue === lastValue` check is skipped; every source is formatted and posted unconditionally.
- The per-source loop body (fetch, RAG lookup, format, post, insert, embed) is otherwise unchanged.

### 4.5 `src/handler.ts` — new ops

- `op === 'loop-start'` / `op === 'loop-stop'`: same `requestContext`-gated token check as the existing `fetch` trigger. On success, write to `agent_settings` via a new `setSetting(db, key, value)` helper in `src/db/settings.ts`, then publish the snapshot with the current ETag (matching `runFetch`'s conditional-write pattern). Return `{ statusCode: 200, body: JSON.stringify({ loopEnabled: <new value> }) }`.
- The `status` op gains a `loopEnabled` field in `StatusResult`, populated from `agent_settings` with a default of `true` if the row is missing (e.g., a snapshot from before this feature shipped).

### 4.6 `src/agent/status.ts` — expose `loopEnabled`

Reads the setting on every `getStatus` call. The reader already reads from the snapshot, so this is a small additive change to the SQL.

### 4.7 `infra/stack.ts` — schedule replacement

Replace the existing `rate(1 day)` schedule with `rate(3 minutes)`. Single line change. No new infra (no DLQ, no alarm — the loop is for local testing, not unattended operation; this is called out in the README).

### 4.8 `scripts/loop-start.sh` / `scripts/loop-stop.sh`

Two new scripts matching the style of `scripts/smoke.sh`: tempfiles for sensitive inputs (the URL, the token), `curl` with the right op, parse the JSON response, print success/failure. Both expect `FUNCTION_URL` and `LOOP_TOKEN` in the environment (sourced from `.env.discord` like the existing smoke script).

---

## 5. Behavioral changes summary

| Scenario | Before | After |
|---|---|---|
| Daily fetch at 1 day | One fetch per day, dedup on | Still works if `FETCH_DEDUP=true`; the schedule is the only change at the infra layer |
| Loop at 3 min | n/a | Two Discord messages per tick (one weather, one crypto) |
| Message content | "Weather update: 72F" | Date, location, weather, crypto, optional closest-past reference, ends with a haiku |
| Dedup on value change | Always on | Off by default; opt-in via `FETCH_DEDUP=true` |
| Stop the loop | n/a | `curl $FUNCTION_URL?token=$LOOP_TOKEN --data '{"op":"loop-stop"}'`. Loop ticks return early; no fetch, no post, no S3 publish. |
| Start the loop | n/a | `curl $FUNCTION_URL?token=$LOOP_TOKEN --data '{"op":"loop-start"}'`. Subsequent ticks post as normal. |
| Status endpoint | snapshotVersion, sources, recentNotifications | Adds `loopEnabled: boolean` |

---

## 6. Error handling

Loop-specific failures follow the same isolation rules as the base spec:

- A `loop-start` / `loop-stop` op that fails the conditional write loses the setting change: the local DB has the new value, but the next invocation hydrates from S3 (which still has the old snapshot) and the change is not visible. The same posture as the existing `runFetch` publish-failure path (base spec §4.2). The user must re-run the curl; the failed attempt is logged in-process but not visible to a fresh reader.
- A `runFetch` invocation that runs while `loop_enabled='false'` is a no-op. It does not write an `agent_runs` row (so the table is not filled with empty rows at 3-min cadence), and it does not republish the snapshot (so the S3 object is not touched).
- A formatter error per source is caught by the existing per-source `try`/`catch` and folded into `agent_runs.error`. The other source still posts.
- A Discord 4xx is not retried (existing behavior); a 5xx gets one ~250ms retry (existing). Same rules apply.

---

## 7. Testing

Unit tests (vitest) for:

- `runFetch` with `loop_enabled='false'`: short-circuits, no fetch, no post, no publish, no run row.
- `runFetch` with `FETCH_DEDUP=false`: two unchanged-value ticks both post.
- `runFetch` with `FETCH_DEDUP=true`: an unchanged-value tick is deduped (regression test for the existing dedup path, which is now opt-in).
- `loop-start` / `loop-stop` ops: write to `agent_settings`, publish the snapshot, return the new `loopEnabled` value.
- `loop-start` / `loop-stop` without `LOOP_TOKEN`: 403, no DB write, no publish.
- Status endpoint: `loopEnabled` reflects the current setting (true / false / missing → default true).
- Formatter receives the new `FormatContext` shape and the new fields are present in the Bedrock request body (via the existing `aws-sdk-client-mock` ConverseCommand matcher).

The RAG corpus-bloat concern is called out in `docs/07-budget-protection.md` as a known limitation; no automated test for it (it would require running the loop for hours to measure).

---

## 8. Docs

Per the user instruction, no new `docs/0X-*.md` tutorial file. Two small changes:

- **`README.md`** — new "Loop mode" subsection under "Quick start" with the curl commands for `loop-start` / `loop-stop`, the env vars (`FETCH_DEDUP`, `LOOP_TOKEN`), and a one-line note that the loop is for local testing.
- **`docs/07-budget-protection.md`** — one paragraph added: with `FETCH_DEDUP=false` at 3-min cadence, expect ~960 Bedrock calls/day (2 sources × 480 ticks). At default model pricing, this is roughly $0.05–$0.10/day vs ~$0.02/year for the once-daily fetch. The RAG corpus (`agent_notifications` + `agent_embeddings`) grows by ~28,800 rows/day; if left running unattended this is the primary cost driver, not the Bedrock calls themselves.

---

## 9. Open concerns (out of scope for this spec)

- **RAG corpus bloat.** At 3-min cadence with `FETCH_DEDUP=false`, `agent_notifications` and `agent_embeddings` grow by ~28,800 rows/day each. The reader and RAG KNN queries still work, but the SQLite file gets larger and S3 storage cost grows linearly. A future spec could add a TTL or a sliding-window cap; this spec does not.
- **Loop token rotation.** `LOOP_TOKEN` is an env var set at deploy time; rotating it requires a redeploy. Same posture as `FETCH_TRIGGER_TOKEN`, called out here for consistency.
- **Unattended operation.** The loop is intended for local testing, not for being left on. The README's "Loop mode" subsection should explicitly say "stop the loop when you're done."
