# SQLite S3 Agent Tutorial — PR4: Reader State-Invariant Fixes + Doc Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on:** PR3 must be merged. This plan assumes `src/agent/status.ts`, `src/handler.ts`, the `status` reader path, and the tutorial docs (`docs/01-architecture.md` through `docs/05-from-tutorial-to-prod.md`) all exist and pass their tests.

**Goal:** Fix two state-inconsistency bugs in the reader's cache-miss branch that the post-merge review surfaced, and clean up the public docs so the tutorial no longer references a private sibling repo or leaves Discord webhook setup as an unexplained exercise. The fix shape is the smallest one that preserves the existing retry-loop behavior on a corrupted or missing S3 object — the bug is the inconsistency, not the loop.

**Architecture:** The two bugs share one root cause: the cache-miss branch in `src/agent/status.ts` updates `state.cachedEtag` and `state.db` in an order that allows a partial failure to leave them in an inconsistent combination. The invariant the cache must preserve is "either both fields are populated and the pair is valid, or both are null/undefined." A failing `openReadOnlyDatabase` should leave `cachedEtag` at its prior value (not the new one). The HEAD-succeeds-but-GET-fails branch should reset `cachedEtag` to `null` so the next call retries cleanly. The retry loop on a permanently broken S3 object is unchanged — it terminates when the operator or the writer fixes the underlying object.

**Tech Stack:** No new dependencies. Reuses the existing test tooling (Vitest, `aws-sdk-client-mock`, `mkdtempSync` for hermetic `/tmp` directories).

---

## File Structure (changes to PR3)

```text
sqlite-s3-agent-tutorial/
├── docs/
│   ├── 01-architecture.md            # MODIFY: remove aws-cloud-agent reference
│   ├── 02-rehydration.md             # MODIFY: link to new Discord webhook doc
│   ├── 05-from-tutorial-to-prod.md   # MODIFY: remove aws-cloud-agent references, generalize framing
│   ├── 06-discord-webhook-setup.md   # NEW: step-by-step Discord webhook creation
│   ├── bedrock-model-comparison.md   # MODIFY: remove aws-cloud-agent / core-llm-wiki references
│   └── superpowers/
│       └── specs/
│           └── 2026-08-08-sqlite-s3-agent-tutorial-design.md  # MODIFY: add §4.3.1
│                                                                       state-invariants
│                                                                       subsection;
│                                                                       update Status line;
│                                                                       remove ~14 aws-cloud-agent
│                                                                       references
├── src/
│   ├── agent/
│   │   └── status.ts                 # MODIFY: clear both cache fields at branch entry;
│   │                                           only assign new pair after open succeeds
│   └── format/
│       └── families.ts                # MODIFY: remove aws-cloud-agent reference
└── tests/
    └── status.test.ts                # MODIFY: add regression tests for failure modes
```

---

## Task 1: Fix Bug 1 — swap `state.db` and `state.cachedEtag` assignment order

**Files:**
- Modify: `src/agent/status.ts`

**Bug:** `src/agent/status.ts` (warm-cache-miss branch) clears `state.db` (close the old handle, set `state.db = undefined`) but leaves `state.cachedEtag` at the prior valid ETag. From that point, every step before `openReadOnlyDatabase` succeeds (`rmSync`, `store.get`, `writeFileSync`, `openReadOnlyDatabase`) can throw and leave the cache in the invalid `(oldEtag, undefined)` combination. The earlier "swap order" fix only addressed the case where `openReadOnlyDatabase` is the failing step — a partial failure in any earlier step still violates the spec's §4.3.1 invariant.

**Fix:** Clear both fields together at the top of the cache-miss branch (right after closing the old handle), then only assign the new pair at the end after `openReadOnlyDatabase` succeeds. The branch now transitions to `(null, undefined)` at entry and only returns to `(string, open handle)` on success — every throwing step preserves the empty-cache state. The GET-null branch's earlier `state.cachedEtag = null` becomes redundant but harmless.

- [ ] **Step 1: Modify `src/agent/status.ts`**

In `src/agent/status.ts`, replace the cache-miss branch (lines 97-128):

```typescript
      if (!cacheHit) {
        // `better-sqlite3` keeps a page cache in memory; if the file on disk changes
        // underneath an open handle, the cache describes a file that no longer exists —
        // silently wrong answers, no error. Close before overwriting (spec §4.3).
        if (state.db !== undefined) {
          state.db.close();
          state.db = undefined;
        }
        // `force: true` makes the delete robust against the file disappearing between the
        // existsSync check and the rmSync call — `/tmp` is shared with the writer, and
        // `/tmp` cleanup can race us too. With `force` the no-op case is harmless.
        rmSync(dbPath, { force: true });

        const object = await store.get(storeKey);
        if (object === null) {
          // HEAD succeeded but GET raced a delete between the two calls — treat as
          // no-snapshot rather than throwing, since the outcome the caller cares about
          // (nothing to query) is identical to the head === null branch above.
          // Reset cachedEtag so the next call retries cleanly rather than leaving
          // (cachedEtag=oldEtag, db=undefined), an invalid state per spec §4.3.1.
          state.cachedEtag = null;
          return { snapshotVersion: null, sources: [], recentNotifications: [] };
        }

        writeFileSync(dbPath, object.body);
        // Assign cachedEtag only after openReadOnlyDatabase succeeds — if open throws,
        // cachedEtag stays at its prior value (or null) and the next call retries cleanly
        // instead of leaving (cachedEtag=newEtag, db=undefined), an invalid state per
        // spec §4.3.1.
        state.db = openReadOnlyDatabase(dbPath);
        state.cachedEtag = object.etag;
      }
```

with:

```typescript
      if (!cacheHit) {
        // `better-sqlite3` keeps a page cache in memory; if the file on disk changes
        // underneath an open handle, the cache describes a file that no longer exists —
        // silently wrong answers, no error. Close before overwriting (spec §4.3).
        // Clear both fields together so a partial failure (rmSync, store.get, write,
        // openReadOnlyDatabase throwing) leaves the cache in the empty-cache state
        // `(null, undefined)` rather than the invalid `(oldEtag, undefined)`. Only the
        // successful open at the end of this branch restores the populated state.
        if (state.db !== undefined) {
          state.db.close();
        }
        state.db = undefined;
        state.cachedEtag = null;
        // `force: true` makes the delete robust against the file disappearing between the
        // existsSync check and the rmSync call — `/tmp` is shared with the writer, and
        // `/tmp` cleanup can race us too. With `force` the no-op case is harmless.
        rmSync(dbPath, { force: true });

        const object = await store.get(storeKey);
        if (object === null) {
          // HEAD succeeded but GET raced a delete between the two calls — treat as
          // no-snapshot rather than throwing, since the outcome the caller cares about
          // (nothing to query) is identical to the head === null branch above. cachedEtag
          // was already cleared at the top of this branch, so the next call retries the
          // full cache-miss path from a known-empty state (spec §4.3.1).
          return { snapshotVersion: null, sources: [], recentNotifications: [] };
        }

        writeFileSync(dbPath, object.body);
        // Assign cachedEtag only after openReadOnlyDatabase succeeds — any throw between
        // here and the top of the branch (rmSync, store.get, writeFileSync, open) leaves
        // the cache in `(null, undefined)` per spec §4.3.1.
        state.db = openReadOnlyDatabase(dbPath);
        state.cachedEtag = object.etag;
      }
```

- [ ] **Step 2: Verify the type-check passes**

Run: `npx tsc -p tsconfig.check.json`
Expected: exit 0, no errors.

---

## Task 2: Fix Bug 2 — reset `state.cachedEtag` on HEAD-succeeds-GET-fails

**Files:**
- Modify: `src/agent/status.ts`

**Bug:** `src/agent/status.ts:110-116` handles the HEAD-succeeds-GET-returns-null branch (race between HEAD and GET, typically a transient S3 inconsistency). The current code returns the empty-state JSON but leaves `state.cachedEtag` at whatever value it held before — typically the prior valid ETag from a previous successful hydration. This violates the invariant `cachedEtag === null ⟺ db === undefined`.

**Fix:** Reset `state.cachedEtag` to `null` before returning the empty-state JSON. The next call sees `cachedEtag === null`, evaluates cache miss, and re-runs the full cache-miss path.

- [ ] **Step 1: Modify `src/agent/status.ts`**

In `src/agent/status.ts`, replace:

```typescript
        const object = await store.get(storeKey);
        if (object === null) {
          // HEAD succeeded but GET raced a delete between the two calls — treat as
          // no-snapshot rather than throwing, since the outcome the caller cares about
          // (nothing to query) is identical to the head === null branch above.
          return { snapshotVersion: null, sources: [], recentNotifications: [] };
        }
```

with:

```typescript
        const object = await store.get(storeKey);
        if (object === null) {
          // HEAD succeeded but GET raced a delete between the two calls — treat as
          // no-snapshot rather than throwing, since the outcome the caller cares about
          // (nothing to query) is identical to the head === null branch above.
          // Reset cachedEtag so the next call retries cleanly rather than leaving
          // (cachedEtag=oldEtag, db=undefined), an invalid state per spec §4.3.1.
          state.cachedEtag = null;
          return { snapshotVersion: null, sources: [], recentNotifications: [] };
        }
```

- [ ] **Step 2: Verify the type-check passes**

Run: `npx tsc -p tsconfig.check.json`
Expected: exit 0, no errors.

---

## Task 3: Add regression tests for the failure modes

**Files:**
- Modify: `tests/status.test.ts`

**A note on test design.** Both bugs are *state-consistency* bugs — the cache-miss branch leaves `(cachedEtag, db)` in an invalid combination, but the function's externally observable behavior is identical in the buggy and fixed versions. The cacheHit check fails in both cases (`state.db === undefined` is enough to force a re-download), so GET calls happen at the same cadence.

The tests below verify that the failure modes propagate correctly (open failure throws, GET-null returns empty state) and that the function recovers cleanly when the underlying S3 object becomes valid. They serve as regression tests and documentation of the expected behavior, not as a demonstration of the bug. The invariant itself is enforced by the spec (Task 4) and code review, not by these tests.

- [ ] **Step 1: Add the test for Bug 1 — open failure propagates and recovers**

Append to `tests/status.test.ts`:

```typescript
  it('propagates openReadOnlyDatabase failures and recovers when the snapshot becomes valid', async () => {
    // An open failure on a corrupted snapshot must:
    // (a) propagate as a rejection (the Lambda returns 500),
    // (b) not poison the reader — once the underlying S3 object is fixed, the next
    //     call downloads valid bytes and returns the seeded data.
    let validBytes: Buffer | null = null;
    let corrupt = true;
    const adaptiveStore = {
      ...ctx.store,
      async get(key: string) {
        if (corrupt) {
          // Bytes that aren't a valid SQLite file — openReadOnlyDatabase will throw.
          return { body: Buffer.from('not a sqlite file'), etag: 'corrupt-etag' };
        }
        return { body: validBytes as Buffer, etag: 'fixed-etag' };
      },
      async head(key: string) {
        return { etag: corrupt ? 'corrupt-etag' : 'fixed-etag' };
      },
    };

    // Seed a valid snapshot so we have bytes to recover with.
    const seeded = await seedSnapshot(ctx.dbPath, ctx.store);
    validBytes = seeded.body;

    const readerDbPath = join(ctx.dir, 'reader-copy.db');
    const reader = createStatusReader(readerDbPath);

    // First call: open throws on the corrupted bytes.
    await expect(reader.getStatus(adaptiveStore, 'memory.db')).rejects.toThrow();

    // Snapshot becomes valid (operator or writer fixes the S3 object).
    corrupt = false;

    // Second call: cache miss, downloads valid bytes, opens successfully, returns
    // the seeded data. Without the fix, state would be (cachedEtag='corrupt-etag',
    // db=undefined) — invalid per spec §4.3.1 — but the test would still pass because
    // the cacheHit check fails for the same reason in both versions. The test documents
    // the recovery behavior; the invariant is enforced by code review.
    const recovered = await reader.getStatus(adaptiveStore, 'memory.db');
    expect(recovered.snapshotVersion).toBe('fixed-etag');
    expect(recovered.sources).toEqual([
      { name: 'weather', lastValue: '72F', lastFetchedAt: 1000, lastPostedAt: 1000 },
    ]);
  });
```

- [ ] **Step 2: Add the test for Bug 2 — GET-null returns empty state and recovers**

Append to `tests/status.test.ts`:

```typescript
  it('returns empty state and recovers on the next call when HEAD succeeds but GET returns null', async () => {
    // The HEAD-succeeds-GET-fails branch (object deleted between HEAD and GET) must:
    // (a) return the empty-state JSON (treating it as no-snapshot, not throwing),
    // (b) reset cachedEtag so the next call retries cleanly,
    // (c) once the underlying object exists, return the seeded data without being
    //     stuck in a HEAD→GET→empty cycle.
    let objectExists = false;
    let validBytes: Buffer | null = null;
    const adaptiveStore = {
      ...ctx.store,
      async get(key: string) {
        if (!objectExists) return null; // HEAD-succeeds-GET-fails
        return { body: validBytes as Buffer, etag: 'fixed-etag' };
      },
      async head(key: string) {
        return { etag: 'fixed-etag' };
      },
    };

    const seeded = await seedSnapshot(ctx.dbPath, ctx.store);
    validBytes = seeded.body;

    const readerDbPath = join(ctx.dir, 'reader-copy.db');
    const reader = createStatusReader(readerDbPath);

    // First call: HEAD says the object exists, GET says it doesn't. Empty state.
    const first = await reader.getStatus(adaptiveStore, 'memory.db');
    expect(first).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });

    // Object materializes (operator creates it out-of-band, or writer runs).
    objectExists = true;

    // Second call: HEAD still says fixed-etag, GET returns valid bytes, returns data.
    // The fix resets cachedEtag to null on the first call, so the second call sees
    // (cachedEtag=null, db=undefined) — cache miss, fresh GET, success.
    const recovered = await reader.getStatus(adaptiveStore, 'memory.db');
    expect(recovered.snapshotVersion).toBe('fixed-etag');
    expect(recovered.sources).toEqual([
      { name: 'weather', lastValue: '72F', lastFetchedAt: 1000, lastPostedAt: 1000 },
    ]);
  });
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run tests/status.test.ts`
Expected: all tests pass — both the existing tests and the two new ones.

If a test fails, the bug is more severe than the review identified. Report the failure with the full test output before proceeding.

---

## Task 4: Update the spec to document the partial-failure state behavior

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-sqlite-s3-agent-tutorial-design.md`

The spec's §4.3 currently describes the cache-miss happy path and the `NoSuchKey` branch but does not document the partial-failure state behavior. Without this, the next implementation pass will make the same bug.

- [ ] **Step 1: Add a new subsection §4.3.1 to the spec**

In `docs/superpowers/specs/2026-08-08-sqlite-s3-agent-tutorial-design.md`, after §4.3 (the closing line "the tutorial teaches it explicitly."), insert a new subsection:

```markdown
### 4.3.1 Partial-failure state invariants

The reader's `ReaderState` has two fields — `cachedEtag` and `db` — and exactly two valid combinations:

- `(cachedEtag: <string>, db: <open handle>)` — the cache holds a valid snapshot.
- `(cachedEtag: null, db: undefined)` — the cache is empty.

Any other combination is a bug. The cache-miss branch must preserve this invariant across every failure mode:

- **`openReadOnlyDatabase` throws** (corrupted snapshot, non-SQLite bytes, disk error): `state.db` stays `undefined`, `state.cachedEtag` stays at its prior value (or `null` on a cold start). The error propagates up — the Lambda returns 500, the next call retries the cache-miss path from scratch.
- **`GetObject` returns `null` after a successful `HEAD`** (transient S3 race, object deleted between calls): `state.cachedEtag` is reset to `null`, the empty-state JSON is returned. The next call retries cleanly.
- **`GetObject` returns `NoSuchKey`** (no snapshot yet — `fetch` has never run): identical to the `null` case above.

The retry loop on a permanently broken S3 object is unavoidable — it terminates when the operator or the writer fixes the underlying object. The invariant is what prevents the loop from behaving incorrectly (e.g., returning stale data from a closed handle) while it runs.
```

- [ ] **Step 2: Update the "Status" line at the top of the spec**

The spec's Status line may read either `**Status:** Implemented` (the merged-to-main
version after PR3) or `**Status:** Approved (ready for implementation planning)` (the
in-progress version, which is what the spec author sees in their IDE before merging
PR3). The search-and-replace below is robust to both: detect which variant is present
and replace it with the new value.

**If the current line is `**Status:** Implemented`:**

Replace:

```markdown
**Status:** Implemented
```

with:

```markdown
**Status:** Implemented (PR3) + state-invariants hardened (PR4)
```

**If the current line is `**Status:** Approved (ready for implementation planning)`:**

Replace:

```markdown
**Status:** Approved (ready for implementation planning)
```

with:

```markdown
**Status:** Implemented (PR3) + state-invariants hardened (PR4)
```

**If neither variant is present**, leave the line alone and add a note to the PR
description explaining that the Status line was already in some other state. The spec
text below Status is unchanged either way.

---

## Task 5: Remove `aws-cloud-agent` references from the spec file

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-sqlite-s3-agent-tutorial-design.md`

The spec references `aws-cloud-agent` and `core-llm-wiki` in roughly 14 places. These are framing references ("same toolchain family as", "same pattern as", "the sibling project") that leak implementation lineage which doesn't belong in a public tutorial. Each occurrence should be removed or generalized so the standalone constraint (line 17) is actually honored.

This task is the spec-cleanup equivalent of Task 6, which does the same for the public docs.

- [ ] **Step 1: Update "Standalone" and "TypeScript, Node 24, ESM" constraints**

In `docs/superpowers/specs/2026-08-08-sqlite-s3-agent-tutorial-design.md`, replace the two adjacent bullet points (lines 17-18):

```markdown
- **Standalone.** No coupling to `aws-cloud-agent`, `core-llm-wiki`, or any other sibling repo. Reusable as a starting point for any agent with persistent state.
- **TypeScript, Node 24, ESM.** Same toolchain family as `aws-cloud-agent`.
```

with:

```markdown
- **Standalone.** Reusable as a starting point for any agent with persistent state. No coupling to any external repo.
- **TypeScript, Node 24, ESM.** Modern, ESM-native, strict.
```

- [ ] **Step 2: Replace the §4.3 closing sentence**

Replace (line 125):

```markdown
The version cache (§4.3) is what makes warm invocations cheap. `setup()` here is just opening a SQLite file, so the payoff is smaller than `aws-cloud-agent`'s MiniSearch rebuild — but the *mechanism* is the same, and the tutorial teaches it.
```

with:

```markdown
The version cache (§4.3) is what makes warm invocations cheap. The mechanism is the same one any warm-cache pattern uses: hold a pointer to the last loaded resource, validate it against the source's current version on each access, and reload only when it has changed. The tutorial teaches that mechanism in its simplest form.
```

- [ ] **Step 3: Replace the "Why close-and-reopen" sentence**

Replace (line 161):

```markdown
**Why close-and-reopen rather than reuse the open handle?** `better-sqlite3` keeps a page cache in memory. If the file on disk changes underneath an open handle, the cache describes a file that no longer exists — silently wrong answers, no error. The mechanism is the same one `aws-cloud-agent` uses for the same reason.
```

with:

```markdown
**Why close-and-reopen rather than reuse the open handle?** `better-sqlite3` keeps a page cache in memory. If the file on disk changes underneath an open handle, the cache describes a file that no longer exists — silently wrong answers, no error. Closing the handle before overwrite is what prevents that.
```

- [ ] **Step 4: Replace the §5 prefix note**

Replace (line 169):

```markdown
Three tables, prefixed `agent_` (matching `aws-cloud-agent`'s convention) so future migrations stay collision-free.
```

with:

```markdown
Three tables, prefixed `agent_` so future migrations stay collision-free.
```

- [ ] **Step 5: Replace the `outcome`/`error` nullable rationale**

Replace (line 210):

```markdown
**`outcome` and `error` are nullable on purpose.** A run row inserted at step 4 of the writer lifecycle (§3.1) and never updated is itself a record: "this run started and never finished." That signal is lost if the columns default to a fake value. Same pattern as `aws-cloud-agent`'s `agent_runs`.
```

with:

```markdown
**`outcome` and `error` are nullable on purpose.** A run row inserted at step 4 of the writer lifecycle (§3.1) and never updated is itself a record: "this run started and never finished." That signal is lost if the columns default to a fake value.
```

- [ ] **Step 6: Replace the §6 principle prose**

Replace (line 238):

```markdown
**The principle: every error category has exactly one right answer, and it's the same answer every time.** `aws-cloud-agent`'s design calls this out explicitly in its §6 prose; the tutorial does the same because it teaches a habit, not just a pattern.
```

with:

```markdown
**The principle: every error category has exactly one right answer, and it's the same answer every time.** The tutorial teaches a habit, not just a pattern.
```

- [ ] **Step 7: Replace the §7 testing rationale**

Replace (line 246):

```markdown
Tests run against a **real SQLite file** with a real `better-sqlite3` handle — no mocks of the database. `aws-cloud-agent`'s design calls this out explicitly ("the library's actual behaviour is the thing under test") and the tutorial adopts the same principle. Network boundaries are mocked because Discord and external APIs are out of our control.
```

with:

```markdown
Tests run against a **real SQLite file** with a real `better-sqlite3` handle — no mocks of the database. The library's actual behaviour is the thing under test, not a re-implementation of it. Network boundaries are mocked because Discord and external APIs are out of our control.
```

- [ ] **Step 8: Replace the §7.1 mocking-table entry**

Replace (line 255):

```markdown
| S3 client | Yes | `aws-sdk-client-mock` (matches `aws-cloud-agent`). |
```

with:

```markdown
| S3 client | Yes | `aws-sdk-client-mock`. |
```

- [ ] **Step 9: Replace the §7.3 smoke-test rationale**

Replace (line 273):

```markdown
`scripts/smoke.sh` invokes the deployed `fetch` op, waits for the run, then invokes `status` and asserts the JSON contains a `weather` source with a `lastValue`. Matches `aws-cloud-agent`'s smoke pattern; tutorial readers can run it after deploy to verify end-to-end.
```

with:

```markdown
`scripts/smoke.sh` invokes the deployed `fetch` op, waits for the run, then invokes `status` and asserts the JSON contains a `weather` source with a `lastValue`. Tutorial readers can run it after deploy to verify end-to-end.
```

- [ ] **Step 10: Replace the §8 out-of-scope entry**

Replace (line 284):

```markdown
- **A `social` retrieval profile, episodic tiers, ontology, outbox.** All `aws-cloud-agent`-specific concepts, all intentionally omitted.
```

with:

```markdown
- **An ontology, semantic retrieval profiles, episodic memory tiers, outbox patterns.** All project-specific concepts that grew up around richer knowledge-graph workloads, intentionally omitted.
```

- [ ] **Step 11: Replace the §10 repo-layout entries**

Replace (line 321):

```markdown
│   └── 05-from-tutorial-to-prod.md  # the deltas vs aws-cloud-agent
```

with:

```markdown
│   └── 05-from-tutorial-to-prod.md  # the deltas vs running this in production
```

And replace (line 360):

```markdown
├── Dockerfile                       # arm64 cross-compile block (§8.5 of aws-cloud-agent)
```

with:

```markdown
├── Dockerfile                       # arm64 cross-compile block
```

- [ ] **Step 12: Replace the §10 closing prose**

Replace (line 367):

```markdown
`docs/01-architecture.md` is the tutorial's *narrative*. The code is the working example; the docs explain why each piece exists. `docs/05-from-tutorial-to-prod.md` is a closing piece that points at `aws-cloud-agent` for readers who outgrow the tutorial — making the lineage explicit.
```

with:

```markdown
`docs/01-architecture.md` is the tutorial's *narrative*. The code is the working example; the docs explain why each piece exists. `docs/05-from-tutorial-to-prod.md` is a closing piece that describes what changes when this tutorial's defaults are no longer the right trade-offs — a checklist for readers who outgrow it.
```

- [ ] **Step 13: Replace the §12.5 model-swap reference**

Replace (line 457):

```markdown
4. If the family is not `zai`, add a registry entry — *only after a live probe* of accepted prefixes and request shape. The probe procedure is documented in the sibling repo (`aws-cloud-agent/docs/superpowers/specs/2026-08-02-model-provider-adapter-design.md` §5). The four-step procedure is mandatory, including the negative control: some families accept unknown request fields silently, so "the request did not 400" is not evidence a field is supported.
```

with:

```markdown
4. If the family is not `zai`, add a registry entry — *only after a live probe* of accepted prefixes and request shape. The four-step procedure is mandatory, including the negative control: some families accept unknown request fields silently, so "the request did not 400" is not evidence a field is supported.
```

- [ ] **Step 14: Verify no remaining `aws-cloud-agent` references in the spec**

Run: `grep -n "aws-cloud-agent\|core-llm-wiki" docs/superpowers/specs/2026-08-08-sqlite-s3-agent-tutorial-design.md`
Expected: no output.

---

## Task 6: Remove `aws-cloud-agent` references from public docs

**Files:**
- Modify: `docs/01-architecture.md`
- Modify: `docs/05-from-tutorial-to-prod.md`
- Modify: `docs/bedrock-model-comparison.md`
- Modify: `src/format/families.ts`

The tutorial is public; `aws-cloud-agent` is a private repo. References to it produce dead links and leak implementation lineage that doesn't belong in a tutorial. Wherever the docs say "this mirrors `aws-cloud-agent`'s pattern" or "the sibling project," rewrite to either drop the reference or frame the choice generically.

The existing `*-plan*.md` files in `docs/superpowers/plans/` are historical implementation records and may be kept as-is — they describe the project's lineage at the time each PR was merged, and removing references would falsify the record.

- [ ] **Step 1: Update `docs/01-architecture.md`**

In the "Why one Lambda, not two" section, replace:

```markdown
`aws-cloud-agent`, the sibling project this tutorial is drawn from, uses two Lambdas — a
writer and a reader — because its reader also runs semantic search backed by a vector
index that needs its own warm-container lifecycle tuning. This tutorial's reader is a
much smaller job: query two tables and return JSON. Splitting it into a second Lambda
would mean a second container image, a second set of IAM grants, and a second cold-start
budget — for a query that returns in single-digit milliseconds once hydrated. One function
with an `op` field is simpler and the tutorial's job is to teach the storage pattern, not
Lambda topology.
```

with:

```markdown
A more ambitious agent might split the reader into its own Lambda — say, when the reader
also runs semantic search backed by a vector index that needs its own warm-container
lifecycle tuning. This tutorial's reader is a much smaller job: query two tables and
return JSON. Splitting it into a second Lambda would mean a second container image, a
second set of IAM grants, and a second cold-start budget — for a query that returns in
single-digit milliseconds once hydrated. One function with an `op` field is simpler and
the tutorial's job is to teach the storage pattern, not Lambda topology.
```

- [ ] **Step 2: Update `docs/05-from-tutorial-to-prod.md`**

In the "What stays the same" section, replace:

```markdown
The rehydration protocol — bootstrap, conditional writes, version-cached reads — doesn't
change shape as the system grows. That's the point of the pattern: it's the same mechanism
whether the payload is a two-table dedup cache or full knowledge graph
with a vector index. What changes is how much work happens between hydrate and publish,
not how hydrate and publish themselves work.
```

with:

```markdown
The rehydration protocol — bootstrap, conditional writes, version-cached reads — doesn't
change shape as the system grows. That's the point of the pattern: it's the same mechanism
whether the payload is a two-table dedup cache or a larger state file with more tables and
indices. What changes is how much work happens between hydrate and publish, not how
hydrate and publish themselves work.
```

Also in the section "The single Lambda split," replace:

```markdown
This tutorial's `fetch` and `status` share one function because the reader's query is
cheap. If your reader starts doing real work — search, aggregation, anything with its own
latency and memory profile — split it into its own function. The two functions still share the storage pattern in this
tutorial's `docs/02-rehydration.md`; only the deployment topology changes.
```

with:

```markdown
This tutorial's `fetch` and `status` share one function because the reader's query is
cheap. If your reader starts doing real work — search, aggregation, anything with its own
latency and memory profile — split it into its own function. The two functions still share
the storage pattern in this tutorial's `docs/02-rehydration.md`; only the deployment
topology changes.
```

Also in the section "More than one writer path," replace:

```markdown
This tutorial has exactly one thing that writes to the snapshot: the `fetch` op, on a
fixed daily schedule. A production agent is more likely to need multiple write paths — a
scheduled job and a manually-triggered one, say — which raises the question of whether
`reservedConcurrentExecutions: 1` is still sufficient once two *different* Lambda
functions might both want to write. It isn't, on its own: reserved concurrency only
serializes invocations of one function. Giving every
writer path the same conditional-write discipline this tutorial uses, so the S3 `If-Match`
precondition — not Lambda's concurrency control — is what actually prevents two writers
from clobbering each other, regardless of how many entry points call into that logic.
```

with:

```markdown
This tutorial has exactly one thing that writes to the snapshot: the `fetch` op, on a
fixed daily schedule. A production agent is more likely to need multiple write paths — a
scheduled job and a manually-triggered one, say — which raises the question of whether
`reservedConcurrentExecutions: 1` is still sufficient once two *different* Lambda
functions might both want to write. It isn't, on its own: reserved concurrency only
serializes invocations of one function. The fix is to give every writer path the same
conditional-write discipline this tutorial uses, so the S3 `If-Match` precondition — not
Lambda's concurrency control — is what actually prevents two writers from clobbering each
other, regardless of how many entry points call into that logic.
```

- [ ] **Step 3: Update `docs/bedrock-model-comparison.md`**

In the "Provenance" blockquote at the top, replace:

```markdown
> **Provenance.** This file is research from a sibling project (`aws-cloud-agent`,
> `@equationalapplications/core-llm-wiki`) where `low`/`med`/`high` tier switching and a
> broader model fleet are first-class concerns. The comparison itself is
> general-purpose — model pricing, capability, and latency characteristics are not
> project-specific — so the file lives here as a starting point for any reader picking a
> Bedrock model.
```

with:

```markdown
> **Provenance.** This file is general-purpose Bedrock model research. Model pricing,
> capability, and latency characteristics are not project-specific, so the file lives
> here as a starting point for any reader picking a Bedrock model. Tier-switching
> workflows that lean on this comparison as a building block are out of scope for this
> tutorial.
```

Scan the rest of the file for any reference to `core-llm-wiki` or `aws-cloud-agent` and replace with a generic statement that doesn't reference a private repo.

- [ ] **Step 4: Update `src/format/families.ts`**

In the file's doc comment, replace:

```typescript
/**
 * Which inference-profile prefixes a Bedrock model family accepts (spec §12.3). Verified
 * against Bedrock, never inferred from a model's name — see the sibling repo's design
 * spec (`aws-cloud-agent/docs/superpowers/specs/2026-08-02-model-provider-adapter-design.md`
 * §5) for the live-probe procedure, including the mandatory negative control.
 */
```

with:

```typescript
/**
 * Which inference-profile prefixes a Bedrock model family accepts (spec §12.3). Verified
 * against Bedrock, never inferred from a model's name. Adding a new family requires a
 * live probe of accepted prefixes and request shape, including a mandatory negative
 * control — some families accept unknown request fields silently, so "the request did
 * not 400" is not evidence a field is supported.
 */
```

And in the error message inside `resolveFamily`, replace:

```typescript
      `Model id "${baseModelId}" matches no known model family. Known families: ` +
        `${MODEL_FAMILIES.map((f) => f.id).join(', ')}. Add one only after a live probe ` +
        `against Bedrock (see aws-cloud-agent's model-provider-adapter design spec §5).`,
```

with:

```typescript
      `Model id "${baseModelId}" matches no known model family. Known families: ` +
        `${MODEL_FAMILIES.map((f) => f.id).join(', ')}. Add one only after a live probe ` +
        `against Bedrock with a negative control.`,
```

- [ ] **Step 5: Verify no remaining `aws-cloud-agent` references in non-plan files**

Run: `grep -rn "aws-cloud-agent\|core-llm-wiki" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs/superpowers/plans .`
Expected: no output.

---

## Task 7: Add Discord webhook setup docs

**Files:**
- Create: `docs/06-discord-webhook-setup.md`
- Modify: `README.md`
- Modify: `docs/02-rehydration.md` (link to the new doc from the setup section)

The README mentions `DISCORD_WEBHOOK_URL` but does not explain how to obtain one. Most new readers will not know that Discord webhooks are channel-level integrations, not application-level credentials.

- [ ] **Step 1: Create `docs/06-discord-webhook-setup.md`**

```markdown
# Discord webhook setup

This tutorial posts to a Discord channel via a **webhook** — a per-channel URL that
anyone with the URL can use to post messages into that channel. Each webhook is scoped
to one channel; the URL is the secret.

## Step 1: Create a Discord channel for the bot

If you don't already have a channel you'd like the bot to post to, create one in your
Discord server. The bot will post to this channel and only this channel — picking a
dedicated channel (e.g. `#weather-bot`) keeps its posts separate from general
discussion.

## Step 2: Open the channel's integrations settings

1. Open the Discord client (desktop or web) and navigate to the channel.
2. Right-click the channel name (or click the gear icon next to the channel name in the
   channel header).
3. Select **Edit Channel**.
4. In the left sidebar, click **Integrations**.

## Step 3: Create a webhook

1. Under **Webhooks**, click **New Webhook**.
2. Give the webhook a name (e.g. `Weather Bot`). The name appears as the "username" on
   posts the bot makes.
3. Optionally, set an avatar by uploading an image.
4. Confirm the **Channel** dropdown shows the channel you want posts to land in.
5. Click **Copy Webhook URL**. The URL has the form
   `https://discord.com/api/webhooks/<id>/<token>` — treat the entire URL as a secret.
   Anyone with the URL can post to the channel.

## Step 4: Configure the tutorial

Export the URL as the `DISCORD_WEBHOOK_URL` environment variable before running
locally — the value stays out of shell history if you set it in your shell profile
or load it from an untracked `.env` file:

```bash
# Local development — load from an untracked .env (gitignored), then export:
export $(cat .env | xargs) && npm run local-fetch
```

When deploying via CDK, source the URL from an untracked file or a CI secret store
rather than echoing it on the command line. CDK reads `DISCORD_WEBHOOK_URL` at
synth time (see `infra/stack.ts:55-63`) and embeds it in the Lambda environment, so
the value should never appear in a published transcript:

```bash
# CI / local deploy — source from a secret store or masked CI variable, then deploy:
set -a; . ./.env.discord; set +a   # .env.discord is gitignored
npm run deploy
```

For production deployments, prefer SSM Parameter Store or Secrets Manager over an
inline Lambda environment value — `cdk.out/` and CloudFormation templates can echo
the value, and any operator with `logs:GetLogEvents` on the function can read it
back from cold-start records. Never commit `.env`, `cdk.out/`, or logs that
contain the webhook URL. The Lambda's IAM role does not need any Discord
permissions — the webhook URL is the only credential.

## Step 5: Verify

Run `npm run local-fetch` once. Within a few seconds you should see a post in the
Discord channel. If you don't see one, check the CloudWatch logs (when deployed) or
the script's stdout (when running locally) — the `agent_runs.error` column captures
per-source failures including Discord post failures.

## Rotating the webhook

If the webhook URL is compromised (e.g. accidentally logged, pasted into a public
forum), the recovery is to delete the compromised webhook in the same **Integrations**
panel and create a new one. Update `DISCORD_WEBHOOK_URL` and redeploy. Webhook
executions remain subject to Discord's normal rate limits and can return HTTP 429;
the `fetch` op should honour the `Retry-After` response header (and the
`X-RateLimit-*` family of headers) rather than retrying on a fixed cadence.
```

- [ ] **Step 2: Update `README.md` to link to the new doc**

In the "Quick start" section, after the code block, add a one-line link:

```markdown
To get a Discord webhook URL, see [docs/06-discord-webhook-setup.md](docs/06-discord-webhook-setup.md).
```

- [ ] **Step 3: Update `docs/02-rehydration.md` to link to the new doc**

At the end of the "Bedrock setup" section, add a sentence:

```markdown
For Discord webhook setup, see [docs/06-discord-webhook-setup.md](06-discord-webhook-setup.md).
```

---

## Task 8: Run the full test suite and verify

- [ ] **Step 1: Run unit tests**

Run: `npm test`
Expected: all tests pass, including the two new tests added in Task 3.

- [ ] **Step 2: Run the type-check**

Run: `npx tsc -p tsconfig.check.json`
Expected: exit 0, no errors.

- [ ] **Step 3: Run the linter (if configured)**

Run: `npm run lint` (only if the project has a lint script; skip if not configured).
Expected: exit 0, no errors.

- [ ] **Step 4: Verify the smoke script syntax is valid**

Run: `bash -n scripts/smoke.sh`
Expected: exit 0 (syntax check only; do not actually run the smoke test against a
deployed stack).

- [ ] **Step 5: Review the diff**

Run: `git diff --stat`
Expected: changes limited to `src/agent/status.ts`, `tests/status.test.ts`,
`docs/superpowers/specs/2026-08-08-sqlite-s3-agent-tutorial-design.md`,
`docs/superpowers/plans/2026-08-08-sqlite-s3-agent-tutorial-pr4-reader-bugfixes.md`,
`docs/01-architecture.md`, `docs/05-from-tutorial-to-prod.md`,
`docs/06-discord-webhook-setup.md` (new), `docs/bedrock-model-comparison.md`,
`src/format/families.ts`, `README.md`, `docs/02-rehydration.md`.

---

## Task 9: Commit and open PR

- [ ] **Step 1: Commit the changes**

```bash
git add -A
git commit -m "fix(pr4): harden reader state invariants on partial failure; add Discord webhook setup docs

- Swap state.db/state.cachedEtag assignment order so a failed openReadOnlyDatabase
  leaves cachedEtag at its prior value, not the new one
- Reset cachedEtag on HEAD-succeeds-GET-fails so the next call retries cleanly
- Add regression tests for both partial-failure scenarios
- Update spec §4.3.1 to document the state-invariant contract
- Add docs/06-discord-webhook-setup.md (new reader got stuck on this)
- Remove aws-cloud-agent / core-llm-wiki references from public docs and code
  comments (private repo; dead links for the public audience)"
```

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin pr4-reader-bugfixes
gh pr create --title "PR4: Reader state-invariant fixes + Discord webhook setup docs" \
  --body "Addresses the post-merge review of PR3 (\`src/agent/status.ts:111\` and
\`src/agent/status.ts:119\`) plus the doc cleanup flagged in the same review.

The two reader bugs share one root cause: the cache-miss branch in
\`src/agent/status.ts\` updates state.cachedEtag and state.db in an order that
allows a partial failure to leave them in an inconsistent combination. The fix
preserves the spec's documented invariant (either both fields are populated and
the pair is valid, or both are null/undefined) with the smallest possible diff
and no new error semantics — the retry loop on a permanently broken S3 object is
unchanged.

Doc cleanup: the tutorial referenced a private sibling repo (\`aws-cloud-agent\`)
in multiple places, producing dead links for the public audience. Removed.
Added \`docs/06-discord-webhook-setup.md\` to fill the gap I hit on first run —
the README mentions the env var but doesn't explain how to obtain the URL."
```

---

## Notes for the implementer

- The two bug fixes are independent and order-independent. Either fix prevents the
  specific loop it targets; both together close the entire class of "state-stuck"
  partial-failure modes.
- The retry loop on a corrupted S3 object is *intentional*. The tutorial teaches the
  pattern of "detect partial failure, retry on the next invocation." Don't add backoff,
  circuit breakers, or call limits — those are out of scope, and adding them would
  hide the underlying problem rather than fix it.
- The tests in Task 3 are regression tests for the externally observable behavior, not
  demonstrations of the bug. The bug is a state-consistency issue (Task 4 documents the
  invariant); the cacheHit check fails in both buggy and fixed versions for the same
  reason (`state.db === undefined`), so the same number of GET calls happen. The test
  verifies that the function's recovery path works when the underlying S3 object
  becomes valid, which is the scenario the fix preserves.
- The doc cleanup in Tasks 5 and 6 is the public-facing reward: a tutorial reader
  hitting the repo for the first time shouldn't see "mirrors `aws-cloud-agent`'s
  pattern" with a dead link, and shouldn't have to google "Discord webhook URL" to
  understand what `DISCORD_WEBHOOK_URL` is.
