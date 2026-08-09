# Trailing Line Break — Design

**Date:** 2026-08-09
**Status:** Implemented (loop spec applied; this design is the follow-up tweak)
**Scope:** Append `\n\n` to every posted `finalMessage` in `runFetch` so each Discord message ends with a visible blank line. Existing line break before `Reminds me of:` stays. No new heading, no heading in `base_message`, no changes to the LLM prompt, no changes to the RAG match shape. One-line writer change + test assertions updated.

---

## 1. Purpose and constraints

After watching a few loop ticks land in Discord, two adjacent messages stacked in the channel blur at the bottom — the eye can't tell where one message ends and the next begins, especially when the most recent message has a "Reminds me of" suffix whose last line is also a three-line haiku (the same shape every tick ends on). A trailing blank line at the end of every message gives each post a clear bottom edge in the channel.

**Constraints carried over from the loop spec:**

- **`base_message` is unchanged.** The trailing `\n\n` is appended to `formatted_message` only, after the suffix is built. The RAG corpus continues to key on `base_message` (the LLM's pre-suffix output), which stays bounded and free of mechanical chrome. This preserves the snowball-prevention guarantee from the loop spec §3.
- **The suffix is still built from `match.baseMessage`.** No change to `findNearestMatch`, no change to `formatted_message = base_message + "\n\nReminds me of: " + match.baseMessage`. The recursive-chain failure mode stays impossible.
- **No LLM prompt change.** The system prompt and `LoopContext` are untouched. The LLM is never asked to add or strip trailing whitespace.
- **Discord-only.** Discord renders `\n\n` as a blank line at the bottom of a message. No markdown, no special characters, no extra Discord-specific code paths.

**Why not add a heading instead?** A heading at the start would help the same way, but the user explicitly opted against it — the trailing blank is enough for the use case, and adding a heading brings two extra decisions (content, format) that aren't necessary. Keep the change minimal.

---

## 2. Architecture

One-line change in `src/agent/fetch.ts`, in the step that builds `finalMessage` (loop spec §4.4 step 6):

```typescript
// Before
const finalMessage = match !== null
  ? preMessage + "\n\nReminds me of: " + match.baseMessage
  : preMessage;

// After
const finalMessage = (match !== null
  ? preMessage + "\n\nReminds me of: " + match.baseMessage
  : preMessage) + "\n\n";
```

The change is a single trailing `+ "\n\n"` applied to the whole ternary expression. No new variable, no new branch, no new function. The match/null branch logic is unchanged — both branches now gain a `\n\n` tail.

Nothing else in the writer, the formatter, the embedder, the RAG lookup, the poster, or the schema changes. `agent_notifications.base_message` is still the LLM's pre-suffix output verbatim; `agent_notifications.formatted_message` gains two trailing newlines.

---

## 3. Data model

No schema change. No new column. Existing `agent_notifications.formatted_message` simply gets two trailing newlines it didn't have before. SQLite stores the trailing `\n\n` as part of the column value; the status endpoint renders `formatted_message` verbatim (per the loop spec §4.6), so the trailing blank line will be visible there too — that's a benign side effect, consistent with the change in Discord.

The snowball-prevention invariant is preserved:

- `base_message` does not contain the trailing `\n\n` (it's appended after the suffix is built, never written to `base_message`).
- `findNearestMatch` still returns `match.baseMessage`, which is bounded by the LLM's output (not by any mechanical chrome).
- A future tick's suffix is built from the past tick's `base_message`, which doesn't contain the trailing `\n\n`, so the suffix doesn't recursively grow.

---

## 4. New / changed modules

### 4.1 `src/agent/fetch.ts` — one-line writer change

In the writer (§4.4 step 6 of the loop spec), wrap the existing ternary in parentheses and append `+ "\n\n"`:

```typescript
const finalMessage = (match !== null
  ? preMessage + "\n\nReminds me of: " + match.baseMessage
  : preMessage) + "\n\n";
```

That's the entire change. No new variable, no new function, no new branch.

### 4.2 Tests — update existing assertions

The happy-path tests in `tests/agent/fetch.test.ts` (and any other test that asserts on `formatted_message`) gain `+ "\n\n"` on the expected value. Specifically:

- **Happy path with RAG history (loop spec §7, first bullet):** the assertion on the `poster.post` argument is updated from `<finalMessage-without-trailing-blank>` to `<finalMessage-without-trailing-blank> + "\n\n"`.
- **First-tick path (loop spec §7, second bullet):** the assertion on `formatted_message = base_message = preMessage` becomes `formatted_message = preMessage + "\n\n"`, and `base_message` stays `preMessage` (no trailing blank there — the blank is appended after `base_message` is computed, before being combined into `formatted_message`).
- **Snowball regression test (loop spec §7, snowball bullet):** the `length < 500` ceiling still holds. Each tick's `formatted_message` grows by 2 chars; worst case across 20 ticks is still well under 500. The assertion text doesn't change; the test passes without modification.
- **Per-source failure, all-sources-failure, formatter-failure, RAG-failure, post-failure tests (loop spec §7):** these tests assert that no Discord post happens (or that the post argument has no suffix). For tests that do assert on the post argument in the success branch, append `+ "\n\n"` to the expected value. Tests asserting on `agent_notifications.formatted_message` also gain the trailing blank. Tests asserting `notificationsSent: 0` are unaffected because no post happens.

No new tests are required for this change — it's a strict superset of the existing post shape, and the existing happy-path tests already cover the post-Discord path. The trailing blank is asserted by the same `poster.post` mock argument checks that already exist.

### 4.3 Docs

No new `docs/0X-*.md` tutorial file (per user instruction in the loop spec §8: small features get a README mention, not a new doc). The README's "Loop mode" subsection does not need updating — it doesn't quote message formats. No docs change.

---

## 5. Behavioral changes summary

| Scenario | Before | After |
|---|---|---|
| Discord message end (no match) | Ends on the haiku's last line | Ends on the haiku's last line + blank line |
| Discord message end (with suffix) | Ends on the past tick's haiku's last line | Ends on the past tick's haiku's last line + blank line |
| Line break before `Reminds me of:` | `\n\n` (existing) | `\n\n` (unchanged) |
| `base_message` content | LLM output verbatim | LLM output verbatim (unchanged) |
| `formatted_message` content | `<preMessage>` or `<preMessage> + "\n\nReminds me of: " + past.baseMessage>` | Same + trailing `\n\n` |
| Snowball-prevention | Intact | Intact (trailing blank is in `formatted_message` only, never in `base_message`) |
| RAG query | Global KNN, no per-source filter | Unchanged |
| RAG corpus entry | `base_message` | Unchanged |
| Status endpoint | Renders `formatted_message` verbatim | Same verbatim — now also shows trailing blank (benign) |
| Discord post HTTP status | 204 on success | Unchanged |
| Per-tick Bedrock calls | 1 Converse + 1 Titan | Unchanged |

---

## 6. Error handling

No new error paths. The change is a pure string append that cannot fail and cannot introduce exceptions. All existing error handling from the loop spec §6 (per-source fetch failure, all-sources-failure, formatter error, RAG lookup failure, post failure) applies unchanged. The trailing `\n\n` is appended after `match` is resolved (so a RAG-lookup failure that produces no `match` still gets the trailing blank via the no-match branch — the blank is not conditional on a successful match).

---

## 7. Testing

- **Updated happy-path test (with RAG history):** `poster.post` argument is asserted to equal `<preMessage> + "\n\nReminds me of: " + past.baseMessage + "\n\n"`. The two `agent_notifications` rows are asserted to have `formatted_message` matching the same value (the loop spec already asserts `formatted_message = finalMessage`; this spec just adds `+ "\n\n"` to that value).
- **Updated first-tick test (no RAG history):** `poster.post` argument is asserted to equal `<preMessage> + "\n\n"`. `agent_notifications.formatted_message` is asserted to equal `<preMessage> + "\n\n"`. `agent_notifications.base_message` is still asserted to equal `<preMessage>` (no trailing blank).
- **Snowball regression test (loop spec §7, snowball bullet):** no change to the assertion. `length < 500` holds with margin. If a future regression re-introduces a recursive suffix, this test will fail loudly before the trailing blank has a chance to mask the bug.
- **All existing failure-path tests:** unchanged. They don't assert on `formatted_message` content in the success branch (because they assert that no post happened). If a test does assert on `formatted_message` and the writer still produces a post (e.g., the RAG-lookup-failure test, which still posts with no suffix), the assertion gains `+ "\n\n"`.

No new tests are introduced. The change is small enough that updating the existing happy-path and first-tick tests is sufficient — the snowball test already covers the worst-case length scenario, and the existing per-source/per-tick mock argument checks already pin the post shape.

---

## 8. Docs

No README change. The README's "Loop mode" subsection describes the loop's purpose (one Discord message per tick with a haiku and optional "Reminds me of" suffix) but does not quote the exact message format. The trailing blank is a visual nicety that doesn't change any user-facing behavior, contract, or cost. Per the user instruction carried over from the loop spec §8 (small features get a README mention only when the feature itself is the change — not for cosmetic tweaks), no README update is required.

---

## 9. Open concerns (out of scope for this spec)

- **Haiku trailing whitespace.** Looking at the snapshot, the LLM produces haikus with trailing spaces on each line (e.g. `"Hot sun glows bright,  \n"`). Discord renders trailing whitespace as just spaces, so the haiku lines look fine, but a future spec could trim the trailing whitespace in the writer for cleaner storage. Out of scope here — the user did not raise this, and the loop spec explicitly kept the LLM prompt minimal.
- **Bounded suffix growth under very long past messages.** With `base_message` bounded at ~150 chars and the suffix at one past `base_message` + the new trailing `\n\n`, the worst-case `formatted_message` length is ~150 + 2 + 150 + 150 + 2 = ~454 chars, well under Discord's 2000-char limit and the 500-char snowball-test ceiling. No further length control needed.
- **Other Discord formatting.** A future spec could add Discord-specific markdown (blockquotes, code blocks, embeds) for further visual distinction. Out of scope here — the user asked for a minimal trailing-blank fix and explicitly declined the header option.
