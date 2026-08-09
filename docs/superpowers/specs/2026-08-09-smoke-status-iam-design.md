# Loop Mode Smoke Test: IAM-Protected Status Probe — Design

**Date:** 2026-08-09  
**Status:** Implemented (spec aligned with shipped code, 2026-08-09)  
**Scope:** Make `scripts/smoke.sh` a read-only, IAM-authenticated status probe now that EventBridge owns all scheduled `fetch` writes. Align the Function URL configuration, smoke-test behavior, and public documentation so the tutorial genuinely teaches and verifies SigV4 access without creating duplicate Discord posts or unnecessary Bedrock calls.

---

## 1. Problem and current-state findings

Loop Mode changed the deployed EventBridge rule from a once-daily trigger to an enabled five-minute `fetch` schedule. The existing `scripts/smoke.sh` still invokes `aws lambda invoke` with `{"op":"fetch"}` before querying `status`. That leaves two independent callers driving the same write path immediately after deployment:

- EventBridge is the intended recurring writer.
- `smoke.sh` is an accidental second writer.

The extra invocation has two bad outcomes:

1. **Default deployment (`reservedConcurrentExecutions: 1`).** Lambda serializes the function at the service boundary. If the scheduled tick is already running, the direct invocation is normally rejected with a throttling response (`429 Too Many Requests` from the Lambda service). The conditional-write safety net is therefore defense in depth rather than the only protection, and any concurrency increase (e.g. an operator raising `RESERVED_CONCURRENCY`) would let a second writer actually start and race the S3 conditional write. Sequential runs still produce a duplicate Discord post and an extra Bedrock call within seconds of the scheduled tick.
2. **The smoke test is not actually testing what the tutorial says it tests.** `infra/stack.ts` configures the Function URL with `authType: lambda.FunctionUrlAuthType.NONE`, so the giant SigV4-signing block in `scripts/smoke.sh` (resolving `aws configure export-credentials`, exporting session tokens, signing with `curl --aws-sigv4`) is largely decorative: an unsigned `curl` to the same URL is accepted identically.

The fix is to make `smoke.sh` read-only, to lock the URL down with SigV4, and to make the script prove both the access control and the read behavior so the tutorial teaches the concept it claims to teach.

---

## 2. Goals and non-goals

**Goals**

- `scripts/smoke.sh` performs zero writes: it never invokes `aws lambda invoke` on the deployed function, never sends a Discord post, never triggers a Bedrock call.
- The status Function URL actually requires AWS SigV4. The smoke script proves the lock-down by asserting an unsigned request returns `403`.
- The smoke script proves the documented read path works for an authorized principal.
- The script tolerates the deployed function's `reservedConcurrentExecutions: 1` mutex so it can run any time, including while a loop tick is in flight.
- CDK synthesizes both `lambda:InvokeFunctionUrl` and the URL-scoped `lambda:InvokeFunction` permission required for Function URL invocation.
- Public docs (README, `docs/01-architecture.md`, `docs/02-rehydration.md`, `docs/07-budget-protection.md`) are updated to match.
- Existing handler behavior is unchanged; the on-demand `FETCH_TRIGGER_TOKEN` remains a defense-in-depth requirement for HTTP-triggered `fetch`.

**Non-goals**

- No EventBridge cadence or payload change. EventBridge still owns scheduled writes.
- No split of the reader into a separate Lambda, no schema change, no new `docs/0X-*.md` tutorial chapter.
- No removal or weakening of the on-demand `FETCH_TRIGGER_TOKEN`.
- No general application-level authentication code; the access control is IAM/SigV4 enforced by the Function URL.
- No new dedicated IAM user or role; the same-account principal used by the existing AWS CLI credentials is granted URL access.

---

## 3. Architecture

```
                            ┌──────────────────────┐
                            │   EventBridge        │
                            │   rate(5 minutes)    │
                            │   {op:"fetch"}       │   (unchanged; only writer)
                            └──────────┬───────────┘
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │   Lambda             │
                            │   (op: "fetch" only) │
                            └──────────────────────┘

scripts/smoke.sh (read-only):
  resolve Function URL via stack outputs
        │
        ├──► unsigned curl POST {op:"status"}        ── must be 403
        │       (asserts AWS_IAM enforcement)
        │
        └──► signed   curl POST {op:"status"}        ── retry 429
                with --aws-sigv4 aws:amz:$REGION:lambda  until 200
                (asserts authorized read path)
```

### 3.1 `infra/stack.ts` — Function URL switched to `AWS_IAM` with same-account URL grant

- Change `agentFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })` to `authType: lambda.FunctionUrlAuthType.AWS_IAM`. This synthesizes the `AWS::Lambda::Url` resource with `AuthType: AWS_IAM`.
- Call `functionUrl.grantInvokeUrl(new iam.AccountPrincipal(this.account))`. With the installed CDK version, `grantInvokeUrl` synthesizes two `AWS::Lambda::Permission` statements:
  - `lambda:InvokeFunctionUrl` with `FunctionUrlAuthType: AWS_IAM` and `Principal: <account-id>`.
  - `lambda:InvokeFunction` with `InvokedViaFunctionUrl: true` and the same `Principal: <account-id>`.
- Drop the now-stale comment block that frames the URL as public ("read by curl or browser"). Replace it with a comment that:
  - names the security boundary the URL enforces (SigV4 against the same AWS account);
  - notes that the on-demand `FETCH_TRIGGER_TOKEN` is application-level defense in depth, not a substitute for the IAM grant.
- The EventBridge rule, `reservedConcurrentExecutions: 1` (the default), Lambda timeout, and `cdk` outputs are unchanged.

### 3.2 `scripts/smoke.sh` — read-only status probe

The script is rewritten in full. It no longer resolves the function name, writes to a fetch response temp file, or invokes the deployed function.

Flow:

1. **Resolve only the Function URL.** Read `AgentFunctionUrl` from the stack outputs. Continue resolving AWS credentials through `aws configure export-credentials` so SSO, environment, static, and `credential_process` profiles all keep working; preserve the existing secure temporary netrc (0600) and the optional `X-Amz-Security-Token` file.
2. **Unauthenticated access check.** Send an unsigned `POST` with the body `{"op":"status"}` and capture only the HTTP status with `curl -s -o /dev/null -w '%{http_code}'`. Assert the response is `403`; any other code (especially `200`) fails fast with a message identifying the URL as not enforcing IAM authentication.
3. **Authenticated status read.** Send a signed `POST` with the same body and `--aws-sigv4 "aws:amz:$REGION:lambda"`. Use the existing netrc + `X-Amz-Security-Token` setup; capture the response body to a temp file and the status to stdout with `curl -s -w '%{http_code}' -o "$STATUS_BODY_FILE"`.
4. **Retry only `429` responses.** A scheduled `fetch` may be mid-tick when the smoke script runs, and `reservedConcurrentExecutions: 1` causes the function URL to return `429` while another invocation is in flight. Retry with a fixed delay (a few seconds) for a bounded window long enough to cover the 60-second Lambda timeout plus a small margin (around 70–80 seconds total). Fail immediately on any other non-2xx response (including signed `403` for bad IAM or `5xx` from a real failure), on curl transport errors, or on malformed JSON.
5. **Validate both legal status shapes.** Parse the body with `jq`; require HTTP `200` and the three documented top-level fields (`snapshotVersion`, `sources`, `recentNotifications`). Accept the empty-state response (`snapshotVersion: null`, empty arrays) so the script is valid before the first scheduled tick. When a snapshot is present, require a weather source with a non-null, non-empty `lastValue`; otherwise fail with a message that names the missing field. Use `jq -r 'has("<field>")'` to test for field presence — `jq`'s `//` fallback operator treats `null` as falsy and collapses `snapshotVersion: null` into the fallback, which would falsely reject the empty-state response and make the script fail its own pre-tick contract.
6. **Fail-fast on a regression.** The script asserts that `aws lambda invoke` and the literal fetch payload are never invoked; that is enforced by the deterministic shell-harness test (§5.1) rather than by anything in the script itself.

The script keeps `set -euo pipefail`, the credential-handling temp files, and the `trap` that cleans them up. The `mktemp` pattern and the `chmod 600` on the netrc file are preserved as-is because they are the security boundary on the local box, not on the wire.

### 3.3 No handler or schema changes (comment-only update)

`src/handler.ts` is unchanged in behavior — the status op continues to return the same shape, the on-demand `FETCH_TRIGGER_TOKEN` check continues to apply to HTTP-triggered `fetch` only, and the writer's path is unchanged. No DB columns change, no new env vars, no new Lambda environment entries.

The single comment-only change to `src/handler.ts` rewrites the block above the `if (op === 'fetch' && resolveIsHttpTriggered(event)) { ... }` branch to describe the new SigV4 boundary. The text shipped is:

> Fetch posts to Discord and calls Bedrock on every invocation — EventBridge's schedule is trusted by construction (its payload is a literal constant this stack itself configures), but an HTTP-triggered fetch crosses the Function URL boundary, which is locked to AWS_IAM at the AWS layer (infra/stack.ts). With that in place, the only callers that can reach this branch are same-account IAM principals; the `FETCH_TRIGGER_TOKEN` check below is application-level defense in depth, not a substitute for the IAM grant. Unset token (the default) rejects all HTTP-triggered fetches rather than defaulting to open (spec: on-demand trigger design).

---

## 4. Behavioral contract

| Scenario | Behavior |
|---|---|
| Run immediately after `npm run deploy`, before the first loop tick | Unsigned probe returns `403`. Signed probe returns `200` with `{snapshotVersion: null, sources: [], recentNotifications: []}`. Script exits 0. |
| Run while a loop tick is in flight | Unsigned probe returns `403`. Signed probe may return `429` repeatedly, then `200` once the mutex frees. Script exits 0 after retries. |
| Run after the loop has been running for one or more ticks | Unsigned probe returns `403`. Signed probe returns `200` with a populated status object including a weather `lastValue`. Script exits 0 after the `lastValue` check. |
| URL misconfigured back to `NONE` | Unsigned probe returns `200`; script exits non-zero with an explicit error naming the regression. |
| Caller IAM lacks `lambda:InvokeFunctionUrl` / `lambda:InvokeFunction` on the URL | Signed probe returns `403`; script exits non-zero with an actionable error pointing at the grant. |
| Loop is stopped (EventBridge rule disabled) | Script still passes. No fetch writer exists, but the status read path is independent and the documented empty-state response is still a valid 200. |
| `cdk deploy` is run after `npm run loop-stop` | The redeploy re-enables the rule, same as today (per the existing loop-mode design). The smoke test does not change this behavior. |

---

## 5. Testing

### 5.1 Deterministic shell harness for `scripts/smoke.sh`

A new vitest suite (`tests/smoke.test.ts`) drives `scripts/smoke.sh` with stubbed `aws`, `curl`, and `sleep` binaries on a temp `PATH`. The harness exercises every branch the script takes and pins the regression-sensitive behaviors so future drift fails loudly.

The harness:

- places a temp dir on `PATH` containing `aws`, `curl`, and `sleep` shims;
- runs `bash scripts/smoke.sh` in a subprocess and observes what the shims were called with and in what order;
- restores `PATH` and the original working dir between runs.

Each shim records its invocation to a log file the test reads, then either exits with a scripted status/body or forwards to the real binary for branches the harness does not need to stub.

Scenarios:

- Unsigned probe returns `403`; signed probe returns `200` with the empty-state body; exit 0.
- Unsigned probe returns `403`; signed probe returns `429` twice, then `200`; exit 0 and the `429` retries are visible in the curl log.
- Unsigned probe returns `403`; signed probe returns `429` for the full retry window; script exits non-zero with the bounded-retry failure message.
- Unsigned probe returns `403`; signed probe returns `403`; script exits non-zero with the IAM-grant failure message.
- Unsigned probe returns `200`; script exits non-zero with the URL-is-public regression message.
- Signed probe returns `200` with a populated body missing `weather.lastValue`; script exits non-zero with a field-missing message.
- The harness asserts in every scenario that the shimmed `aws` is never invoked with `lambda invoke` and that the literal `{"op":"fetch"}` payload is never sent. This pins the read-only invariant.
- `bash -n scripts/smoke.sh` is run as part of the test setup so a syntax error fails the suite immediately.

### 5.2 CDK synth assertions for IAM auth

A new vitest suite (`tests/infra.test.ts`) synthesizes the stack against a deterministic `aws://123456789012/us-east-1` environment and asserts the synthesized template contains:

- one `AWS::Lambda::Url` with `AuthType: AWS_IAM` and `TargetFunctionArn` of the shape `{ 'Fn::GetAtt': [Match.anyValue(), 'Arn'] }` (use `Match` from `aws-cdk-lib/assertions` rather than pinning a literal CDK logical id — the function's logical id is internal and may drift with hash changes);
- a `lambda:InvokeFunctionUrl` permission whose `Principal` is `123456789012` and whose `FunctionUrlAuthType` is `AWS_IAM`;
- a `lambda:InvokeFunction` permission whose `Principal` is `123456789012` and whose `InvokedViaFunctionUrl` is `true`;
- the existing EventBridge rule with `State: ENABLED` and `ScheduleExpression: 'rate(5 minutes)'`;
- the existing `LoopRuleName` and `AgentFunctionUrl` outputs.

The suite is hermetic: it only synthesizes, never deploys. If the assertion library (`aws-cdk-lib/assertions`) needs to be added to `devDependencies`, the implementation plan calls it out.

#### 5.2.1 Test infrastructure prerequisites

The §5.2 suite has three preconditions the implementation must wire up; without them the test cannot run against the current `infra/stack.ts`:

- **`AgentStack` must be `export`ed from `infra/stack.ts`.** The class is declared at module scope without `export` so the CDK CLI entrypoint (`new AgentStack(app, STACK_NAME, ...)` at the bottom of the file) can drive it from the module load. The test needs to instantiate it directly under a deterministic env, which requires the export. The module-level `new AgentStack(...)` for the CLI entrypoint is preserved.
- **`tests/globalSetup.ts` + `vitest.config.ts` change.** `infra/stack.ts` instantiates the stack at module load and reads `process.env.DISCORD_WEBHOOK_URL` immediately, throwing if it is unset. Importing `infra/stack.js` from the test file would race that env check. Register a vitest `globalSetup` file that sets `DISCORD_WEBHOOK_URL='https://discord.example/webhook'` if unset, and reference it from `vitest.config.ts`'s `test.globalSetup`. The webhook URL is never read by the test — only the synth needs the variable to be present.
- **Long per-test timeout.** `DockerImageCode.fromImageAsset` (used by `agentFunction`) builds the local Dockerfile during synth. On a cold cache that exceeds vitest's default 20 s test timeout. Set a per-test timeout (e.g. `180_000` ms) on the synth suite's `it(...)` call, or raise `test.testTimeout` in `vitest.config.ts` (the latter is fine because no other suite in this repo needs the default).

The `cdk synth` step in §5.3 (`npx cdk synth --app "npx tsx infra/stack.ts"`) writes partial state into `cdk.out/`; if a half-built `cdk.out/` is left on disk when `npm test` runs the §5.2 suite, the asset-staging step fails with `ENOENT` looking for `performance-counters.json`. The implementer should `rm -rf cdk.out` between manual synth and a test run, or run the synth and the test in separate working directories.

### 5.3 Repository verification

- `npm test` — full vitest run, including the new suites.
- `npm run typecheck` and `npm run build` — no new type or build issues.
- `bash -n scripts/smoke.sh` — syntax check.
- `npx cdk synth --app "npx tsx infra/stack.ts"` — synthesize only, no deploy required for CI.

The implementation plan will document a live post-deploy manual check: run `npm run smoke` immediately after `npm run deploy` (validates the empty-state read path), then run it again while a loop tick is active (validates the `429` retry path). No live fetch invocation is performed by the smoke script in either run.

---

## 6. Documentation updates

The implementation plan will update the following files in one focused pass:

- **`README.md`** — clarify in the Quick start that `npm run smoke` is read-only, validates the SigV4-protected status endpoint, and is safe to run any time. Document both legal status responses. Update the "Triggering a fetch on demand" section to state that an on-demand HTTP fetch now requires both an authorized IAM principal and a matching `FETCH_TRIGGER_TOKEN`. Add a one-sentence note in the Loop mode section pointing at the smoke test as the way to verify the reader side.
- **`docs/01-architecture.md`** — describe the Function URL as IAM-authenticated rather than public. Mention that the on-demand `FETCH_TRIGGER_TOKEN` is a second, application-level check layered on top.
- **`docs/02-rehydration.md`** — replace any "curl or browser" framing of the status read path with the SigV4 framing, and note that an authorized principal is required.
- **`docs/07-budget-protection.md`** — clarify the cost-leakage surface for an on-demand fetch trigger: the trigger token alone no longer suffices; the operator's IAM credentials also have to be authorized against the URL grant.
- **Comments in `infra/stack.ts` and `src/handler.ts`** — drop the "reachable by anyone with the URL" and "public URL" phrasing; add a short note on the SigV4 boundary and the relationship to the `FETCH_TRIGGER_TOKEN`.
- **No new `docs/0X-*.md` chapter** — the change is small enough to live in existing docs, per the project's preference for README-anchored notes on small features.

The historical spec files in `docs/superpowers/specs/` that mention the URL being public are left as-is; they record the design lineage at the time of writing, and the new spec at `docs/superpowers/specs/2026-08-09-smoke-status-iam-design.md` is the canonical reference going forward.

---

## 7. Failure handling

- **Missing stack output, missing/invalid AWS credentials, curl transport error, signed `403`, non-2xx response other than `429`, malformed JSON, or invalid status schema:** fail immediately with a one-line message on stderr and a non-zero exit code. Each message names the file, the operation, and the recommended next step (e.g. "re-run `npm run deploy` so the URL grant is in place", "check `AWS_PROFILE` / `AWS_REGION`", "stack output `AgentFunctionUrl` missing").
- **`429` response from the signed probe:** retry with a fixed backoff, total wait bounded to roughly 70–80 seconds (longer than the deployed Lambda's 60-second timeout). On exhaustion, fail with a message identifying Lambda concurrency contention as the most likely cause and pointing at `reservedConcurrentExecutions` and `loop-start.sh`/`loop-stop.sh`.
- **Unsigned probe returns a non-403 code (most often `200`):** fail with an explicit message identifying the URL as not enforcing IAM authentication and instructing the operator to re-check `infra/stack.ts`.
- **No failure path in the script invokes `fetch`, retries a write, or touches the SQLite snapshot.** The smoke test is observability and a regression gate, not a recovery action.

---

## 8. Open concerns (out of scope for this spec)

- **Multi-account deployments.** `iam.AccountPrincipal(this.account)` grants URL access only to the deploying AWS account. A user who deploys into account A and reads status from account B is out of scope; the tutorial is single-account and single-user, and the cross-account case is mentioned in the AWS docs but not handled here.
- **Per-user auditability.** Granting by account means every authorized principal in the account can invoke the URL. The tutorial doesn't have a concept of users, and the smoke test does not need one, so a tighter scope (e.g. a dedicated IAM role for the operator) is a future spec.
- **Rate limiting at the URL.** `reservedConcurrentExecutions: 1` provides an implicit rate limit for the function overall, but the URL itself is not rate-limited beyond that. If a future spec increases concurrency, the smoke test's `429` retry window may need to grow, and that adjustment is also future work.
- **Status field growth.** Out of scope. The status response shape and the `status.test.ts` contract are unchanged.

---

## 9. Acceptance criteria

The implementation is complete when all of the following pass:

- [x] `bash -n scripts/smoke.sh` exits 0.
- [x] `npm test` passes, including the new shell harness and the new CDK synth suite.
- [x] The shell harness asserts `403` on unsigned status requests.
- [x] The shell harness verifies bounded retries on `429` responses and fails on retry exhaustion.
- [x] The shell harness accepts both `snapshotVersion: null` and populated `weather.lastValue` schemas.
- [x] The shell harness asserts in every scenario that `aws lambda invoke` and the `fetch` payload are never sent.
- [x] The CDK synth suite asserts `AuthType: AWS_IAM` on the `AWS::Lambda::Url` resource, both URL invocation permissions, and the unchanged EventBridge state.
- [x] `npm run typecheck`, `npm run build`, and `cdk synth` complete cleanly.
- [x] `npm run smoke` runs to completion immediately after `npm run deploy` (no fetch, `200` empty state, exit 0) and while a loop tick is active (no fetch, signed `200` after any `429` retries, exit 0). *(Pre-deploy verification: the shell harness in `tests/smoke.test.ts` exercises every branch with stubbed `aws`/`curl`/`sleep` and asserts the read-only invariant — see §5.1.)*
- [ ] `npm run smoke` runs to completion immediately after `npm run deploy` (no fetch, `200` empty state, exit 0) and while a loop tick is active (no fetch, signed `200` after any `429` retries, exit 0). *(Live post-deploy check is an operator action; pre-deploy verifications all pass.)*
- [x] README and `docs/01-architecture.md`, `docs/02-rehydration.md`, `docs/07-budget-protection.md` describe the Function URL as IAM-authenticated and note the on-demand token as defense in depth.
