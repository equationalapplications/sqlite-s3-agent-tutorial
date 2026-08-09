# Loop Mode + Poetic Closing — Design

**Date:** 2026-08-09
**Status:** Draft (pending user review)
**Scope:** Replaces the once-daily schedule with a 3-minute loop, makes the Discord message more varied and fun (date + location + weather + crypto + closest-match context, ending with a short haiku), and adds curl commands to start and stop the loop. `loop-stop` actually disables the EventBridge rule so the recurring AWS invocations stop — the loop shuts down in AWS, not just in the Lambda. No dedup, no new user-facing tutorial doc.

---

## 1. Purpose and constraints

The base tutorial posts one Discord message per day, on value change only. For local testing and quick iteration, a 3-minute cadence is more useful — you can see the LLM's output in seconds, not hours — and the message should be more varied (incorporating date, location, and a creative closing) rather than the current template-y "Weather update: 72F" / "Crypto update: 67234.10". When the test is over, the loop should actually stop running in AWS — no reason to keep a recurring trigger alive when no one is looking at the output.

**Constraints carried over from the base spec:** standalone, TypeScript/Node 24/ESM, public-tutorial quality, no VPC/DB server, single-writer invariant, single-user, reader stays read-only.

**New constraints this feature must respect:**

- **One writer, no dedup.** The existing `runFetch` is the only writer. It always fetches, always formats, always posts. No per-source value-change dedup, no `FETCH_DEDUP` env var, no toggle. The loop is short-lived (minutes to hours) and meant for testing — a missed post is harmless, a silent post-skip is confusing.
- **`loop-stop` actually disables the EventBridge rule.** A stopped loop means no further scheduled invocations, not a Lambda that returns early. Same Lambda, same Function URL, just no trigger firing. `loop-start` re-enables it.
- **No new user-facing tutorial doc.** The base tutorial teaches the pattern, not the loop. The README gets a short "Loop mode" subsection with the curl commands; `docs/07-budget-protection.md` gets a one-paragraph note that the loop drives ~960 Bedrock calls/day while running. No new `docs/0X-*.md`.
- **Numerology is out.** The closing beat is a short haiku the LLM generates, not a numerology sentence. LLMs produce cliché numerology platitudes; a haiku gives them actual creative room and reads as varied across runs.
- **No RAG corpus cap in this spec.** The RAG invariant "every posted message is searchable" stays intact. The corpus grows at 3-min cadence while the loop runs, which is fine because the loop is short-lived. A future spec could add a cap or vacuum job; that's out of scope here.

---

## 2. Architecture

The deploy changes (all in `infra/stack.ts`):
- The existing `FetchSchedule` EventBridge rule is given an explicit `ruleName: 'sqlite-s3-agent-tutorial-fetch-loop'` (so the handler can refer to it stably), and its schedule is changed from `rate(1 day)` to `rate(3 minutes)`. Same Lambda target, same `{op:"fetch"}` payload.
- The Lambda role gains two new permissions: `events:EnableRule` and `events:DisableRule`, scoped to that rule's ARN.
- The Lambda environment gains two new vars: `LOOP_RULE_NAME` (the rule's full name) and `LOOP_TOKEN` (the gate for the new ops, default-deny if unset, same posture as `FETCH_TRIGGER_TOKEN`).

The runtime changes:
- `runFetch` is unchanged in structure. It always fetches, always formats, always posts. No dedup-on-unchanged-value check.
- The formatter's user prompt gains structured fields: `date`, `location`, `weatherValue`, `cryptoValue`, in addition to the existing `source` and `rawValue`. The system prompt instructs the LLM to (1) write a short friendly comment that draws on the inputs, (2) naturally reference the closest past reading if provided, and (3) end with a brief haiku (5-7-5) that incorporates the temperature, the crypto value, and the day's vibe.

The control plane changes:
- Two new ops, `loop-start` and `loop-stop`, gated by `LOOP_TOKEN` (same constant-time check pattern as `FETCH_TRIGGER_TOKEN`). They call `EventBridge.EnableRuleCommand` / `DisableRuleCommand` on the rule named by `LOOP_RULE_NAME`. They do not touch the SQLite snapshot — EventBridge is the source of truth. They return `{ statusCode: 200, body: JSON.stringify({ loopState: 'ENABLED' | 'DISABLED' }) }` based on the call's result.

```
EventBridge rate(3 min) ──> Lambda (op:"fetch")
                                  │          (rule is ENABLED by default;
                                  │           loop-stop flips it to DISABLED,
                                  │           which stops all further invocations)
                                  ▼
                            runFetch
                              │
                              ├─ per-source:
                              │     fetch, findNearestMatch (RAG),
                              │     formatter.format(ctx), post to Discord,
                              │     insert agent_notifications row, embed + store
                              │
                              └─ publish snapshot to S3 (conditional)

curl "FUNCTION_URL?token=$LOOP_TOKEN" --data '{"op":"loop-stop"}'
                                       │
                                       └─ EventBridge.DisableRuleCommand(
                                            Name: process.env.LOOP_RULE_NAME)
                                          → rule state = DISABLED, no more ticks
```

---

## 3. Data model

**No schema changes.** `agent_sources`, `agent_notifications`, `agent_runs`, and `agent_embeddings` are unchanged. `agent_notifications` and `agent_embeddings` grow while the loop runs (~960 rows/day each at 3-min cadence with two sources), which is fine because the loop is short-lived. A RAG corpus cap or vacuum job is a future spec, called out as out of scope.

---

## 4. New / changed modules

### 4.1 `src/config.ts` — new env vars

- `LOOP_TOKEN` (string, optional, default `null`): gates the new `loop-start` / `loop-stop` ops. Same default-deny posture as `FETCH_TRIGGER_TOKEN` (rejects with 403 when unset).
- `LOOP_RULE_NAME` (string, required if `LOOP_TOKEN` is set, default `null`): the EventBridge rule to enable/disable. Set by the CDK stack at synth time.

No new parser — both reuse the existing `str` / `optionalStr` helpers.

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

### 4.4 `src/agent/fetch.ts` — fetch all four values, no dedup

The writer is structurally unchanged but now:
- Fetches all four values up front (weather, crypto, plus the location from config and the date from `now()`) so the formatter can receive them in a single `FormatContext` per source.
- Per-source iteration: no dedup check. Every source is formatted and posted every tick.
- Per-source format call receives a full `FormatContext` populated from the up-front fetches plus the per-source `rawValue` and `similarPast` lookup.

### 4.5 `src/handler.ts` — new ops, EventBridge client

- Adds an `EventBridgeClient` to the `InjectedClients` interface (with a default constructed from `config.region`), constructed once per invocation like the existing `S3Client` and `BedrockRuntimeClient`.
- `op === 'loop-start'`: token check → `EnableRuleCommand({ Name: config.loopRuleName })` → return `{ loopState: 'ENABLED' }`. On error, return `{ statusCode: 500, body: JSON.stringify({ error: ... }) }`.
- `op === 'loop-stop'`: token check → `DisableRuleCommand({ Name: config.loopRuleName })` → return `{ loopState: 'DISABLED' }`. Same error shape.
- The `status` op is unchanged (no new fields).

### 4.6 `infra/stack.ts` — schedule, env, IAM

- Set `ruleName: 'sqlite-s3-agent-tutorial-fetch-loop'` on the `FetchSchedule` rule.
- Change `schedule: events.Schedule.rate(cdk.Duration.days(1))` to `events.Schedule.rate(cdk.Duration.minutes(3))`.
- Add `LOOP_RULE_NAME: <rule.ruleName>` and conditional `LOOP_TOKEN: <props.loopToken>` to the Lambda environment.
- Add a new IAM `PolicyStatement`: `events:EnableRule`, `events:DisableRule` on `rule.ruleArn`. The `retryAttempts: 0` and `RuleTargetInput.fromObject({ op: 'fetch' })` already in place stay.

### 4.7 `scripts/loop-start.sh` / `scripts/loop-stop.sh`

Two new scripts matching the style of `scripts/smoke.sh`: tempfiles for sensitive inputs (the URL, the token), `curl` with the right op, parse the JSON response, print success/failure. Both expect `FUNCTION_URL` and `LOOP_TOKEN` in the environment (sourced from `.env.discord` like the existing smoke script).

---

## 5. Behavioral changes summary

| Scenario | Before | After |
|---|---|---|
| Daily fetch at 1 day | One fetch per day, dedup on | Schedule changed to 3 min, no dedup. Same `op:"fetch"`, same Lambda. |
| Loop at 3 min | n/a | Two Discord messages per tick (one weather, one crypto) |
| Message content | "Weather update: 72F" | Date, location, weather, crypto, optional closest-past reference, ends with a haiku |
| Dedup on value change | Always on | Removed. Writer always posts. |
| Stop the loop | n/a | `curl $FUNCTION_URL?token=$LOOP_TOKEN --data '{"op":"loop-stop"}'`. EventBridge rule state = DISABLED. No further scheduled invocations. |
| Start the loop | n/a | `curl $FUNCTION_URL?token=$LOOP_TOKEN --data '{"op":"loop-start"}'`. Rule state = ENABLED. Subsequent ticks post as normal. |
| Status endpoint | snapshotVersion, sources, recentNotifications | Unchanged |

---

## 6. Error handling

- A `loop-start` / `loop-stop` op that fails the EventBridge API call returns 500 with the error message. The DB snapshot is not touched (EventBridge is the source of truth, not the snapshot).
- A `runFetch` invocation that fails the EventBridge call is not a concern — `runFetch` is invoked *by* EventBridge, not the other way around. The `events:DisableRule` call simply means EventBridge stops calling `runFetch`.
- A formatter error per source is caught by the existing per-source `try`/`catch` and folded into `agent_runs.error`. The other source still posts.
- A Discord 4xx is not retried (existing behavior); a 5xx gets one ~250ms retry (existing). Same rules apply.

---

## 7. Testing

Unit tests (vitest) for:

- `runFetch` always posts (one run, both sources' values present, two `agent_notifications` rows, two Discord posts, no dedup-skip).
- `runFetch` with both sources fetched the same value as last time: both still post (regression test for the removed dedup path).
- `loop-start` op with valid `LOOP_TOKEN`: calls `EventBridge.EnableRuleCommand` with the rule name from env, returns 200 `{loopState: 'ENABLED'}`.
- `loop-stop` op with valid `LOOP_TOKEN`: calls `EventBridge.DisableRuleCommand`, returns 200 `{loopState: 'DISABLED'}`.
- `loop-start` / `loop-stop` without `LOOP_TOKEN`: 403, no EventBridge call.
- Formatter receives the new `FormatContext` shape and the new fields are present in the Bedrock request body (via the existing `aws-sdk-client-mock` ConverseCommand matcher).
- Existing RAG tests: unchanged. `findNearestMatch` still works against the growing corpus.

No tests for the RAG corpus-bloat rate (would require running the loop for hours to measure); called out as a known characteristic in the budget note, not a testable invariant.

---

## 8. Docs

Per the user instruction, no new `docs/0X-*.md` tutorial file. Two small changes:

- **`README.md`** — new "Loop mode" subsection under "Quick start" with the curl commands for `loop-start` / `loop-stop`, the env vars (`LOOP_TOKEN`, `LOOP_RULE_NAME`), and a one-line note that the loop is for local testing and should be stopped when done.
- **`docs/07-budget-protection.md`** — one paragraph added: with the loop running at 3-min cadence, expect ~960 Bedrock calls/day (2 sources × 480 ticks). At default model pricing, this is roughly $0.05–$0.10/day. The RAG corpus (`agent_notifications` + `agent_embeddings`) grows by ~28,800 rows/day; while the loop is short-lived this is fine. `loop-stop` disables the EventBridge rule, which is the way to actually shut down the recurring cost.

---

## 9. Open concerns (out of scope for this spec)

- **RAG corpus bloat over long runs.** If the loop is ever left running for days, `agent_notifications` and `agent_embeddings` grow linearly. A future spec could add a sliding-window cap or a vacuum job. This spec keeps the "every posted message is searchable forever" RAG invariant intact and relies on the short-lived nature of the loop in practice.
- **Loop token rotation.** `LOOP_TOKEN` is an env var set at deploy time; rotating it requires a redeploy. Same posture as `FETCH_TRIGGER_TOKEN`.
- **Unattended operation.** The loop is intended for local testing, not for being left on. The README's "Loop mode" subsection should explicitly say "stop the loop when you're done — `loop-stop` disables the EventBridge rule so no further invocations occur and the recurring AWS cost stops."
