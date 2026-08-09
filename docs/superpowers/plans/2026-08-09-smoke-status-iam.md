# Smoke Status Probe: IAM-Protected Function URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `scripts/smoke.sh` into a read-only IAM-authenticated status probe: lock the deployed Function URL to `AWS_IAM`, grant same-account URL access, and rewrite the smoke script so it never invokes `fetch`, never posts to Discord, and never calls Bedrock — instead it (a) asserts an unsigned probe returns `403`, and (b) issues a SigV4-signed `status` POST with bounded `429` retries.

**Architecture:** `infra/stack.ts` switches the Function URL auth to `AWS_IAM` and calls `functionUrl.grantInvokeUrl(new iam.AccountPrincipal(this.account))`, which synthesizes both `lambda:InvokeFunctionUrl` and the URL-scoped `lambda:InvokeFunction` permission. `scripts/smoke.sh` is rewritten end-to-end as a read-only probe: it resolves only `AgentFunctionUrl`, runs an unsigned `curl` and asserts `403`, then runs a signed `curl` (reusing the existing netrc + `X-Amz-Security-Token` machinery) and asserts `200` with the documented status shape, retrying only `429`s within a bounded window. A new vitest shell harness (`tests/smoke.test.ts`) stubs `aws`, `curl`, and `sleep` on a temp `PATH` to deterministically exercise every branch and pin the read-only invariant. A new `tests/infra.test.ts` synthesizes the stack against `aws://123456789012/us-east-1` and asserts the IAM grants on the URL resource. Public docs (README, `docs/01-architecture.md`, `docs/02-rehydration.md`, `docs/07-budget-protection.md`) are updated to describe the URL as SigV4-protected.

**Tech Stack:** TypeScript / Node 24 / ESM, vitest, `aws-cdk-lib/assertions`, AWS CDK, AWS CLI, `curl --aws-sigv4`.

**Design doc:** [docs/superpowers/specs/2026-08-09-smoke-status-iam-design.md](../specs/2026-08-09-smoke-status-iam-design.md)

---

## File Structure

**Modified:**
- `infra/stack.ts` — switch Function URL `authType` to `AWS_IAM`; add `functionUrl.grantInvokeUrl(new iam.AccountPrincipal(this.account))`; update the surrounding comment block to describe the SigV4 boundary.
- `src/handler.ts` — drop the "reachable by anyone with the Function URL" comment in the HTTP-triggered `fetch` gating block; add a short note on the SigV4 boundary and the `FETCH_TRIGGER_TOKEN` relationship.
- `scripts/smoke.sh` — fully rewritten: read-only, unsigned probe (assert `403`), signed probe (assert `200` with retry on `429`), schema validation.
- `package.json` — add `aws-cdk-lib/assertions`-compatible devDep note if needed (no new runtime deps).
- `README.md` — clarify `npm run smoke` as read-only and SigV4-protected; document both legal status responses; update "Triggering a fetch on demand" section to note the IAM principal requirement; add Loop-mode pointer to smoke test.
- `docs/01-architecture.md` — describe the Function URL as IAM-authenticated; mention the on-demand `FETCH_TRIGGER_TOKEN` as defense in depth.
- `docs/02-rehydration.md` — replace "curl or browser" framing with SigV4 framing; note authorized-principal requirement.
- `docs/07-budget-protection.md` — clarify the on-demand fetch trigger requires both a token and an authorized IAM principal.

**Created:**
- `tests/smoke.test.ts` — vitest shell harness that stubs `aws`, `curl`, `sleep` on a temp `PATH`, drives `bash scripts/smoke.sh`, and pins every branch + the read-only invariant.
- `tests/infra.test.ts` — vitest CDK synth suite that asserts `AWS::Lambda::Url` `AuthType: AWS_IAM`, both URL invocation permissions, and the unchanged EventBridge rule.

---

## Task 1: Lock the Function URL to `AWS_IAM` and grant same-account URL access

**Files:**
- Modify: `infra/stack.ts:113-121`
- Test: `tests/infra.test.ts` (new file in Task 3)

- [ ] **Step 1: Update the Function URL auth type and add the URL grant**

Replace the block from `// ---- Function URL (status reads, PR3 completes the op) ----` through the `addFunctionUrl({...})` call (currently `infra/stack.ts:113-121`) with the following — leaving the rest of the file unchanged:

```typescript
    // ---- Function URL (status reads, op:status) ----

    // Locked to AWS_IAM (smoke-status-iam design §3.1): the URL enforces SigV4
    // at the AWS boundary; the on-demand `FETCH_TRIGGER_TOKEN` in src/handler.ts
    // is application-level defense in depth for the HTTP-triggered `fetch` op
    // (which EventBridge never invokes) — not a substitute for this grant.
    const functionUrl = agentFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // Same-account principal (design §3.1). `grantInvokeUrl` synthesizes both
    // `lambda:InvokeFunctionUrl` and the URL-scoped `lambda:InvokeFunction`
    // permission required for Function URL invocation. Cross-account access is
    // out of scope (design §8); per-user auditability is a future spec.
    functionUrl.grantInvokeUrl(new iam.AccountPrincipal(this.account));
```

- [ ] **Step 2: Run typecheck to confirm the new auth type and grant compile**

Run: `npm run typecheck`
Expected: PASS — `FunctionUrlAuthType.AWS_IAM` exists in the installed CDK (verified via `node_modules/aws-cdk-lib/aws-lambda/lib/function-url.d.ts:10`), `grantInvokeUrl` accepts `IGrantable` (line 140), and `AccountPrincipal` is exported from `aws-cdk-lib/aws-iam`.

- [ ] **Step 3: Confirm no other handler-side changes are needed**

Run: `grep -n "public URL\|reachable by anyone" src/handler.ts infra/stack.ts`
Expected: at least one match in `src/handler.ts:149` (the comment in the `op === 'fetch'` HTTP-triggered gating branch) and possibly elsewhere. We will fix the handler comment in Task 2.

- [ ] **Step 4: Commit**

```bash
git add infra/stack.ts
git commit -m "feat(infra): lock function URL to AWS_IAM with same-account grant"
```

---

## Task 2: Update handler comment to describe the SigV4 boundary

**Files:**
- Modify: `src/handler.ts:147-157` (the comment and `if (op === 'fetch' && resolveIsHttpTriggered(event))` block)

- [ ] **Step 1: Replace the misleading comment in the HTTP-triggered fetch gating block**

Replace the comment block at `src/handler.ts:147-151` (the comment that begins "Fetch posts to Discord and calls Bedrock...") with the following. Keep the `if (op === 'fetch' && resolveIsHttpTriggered(event)) { ... }` block immediately below it unchanged:

```typescript
  // Fetch posts to Discord and calls Bedrock on every invocation — EventBridge's schedule
  // is trusted by construction (its payload is a literal constant this stack itself
  // configures), but an HTTP-triggered fetch crosses the Function URL boundary, which
  // is locked to AWS_IAM at the AWS layer (infra/stack.ts). With that in place, the
  // only callers that can reach this branch are same-account IAM principals; the
  // `FETCH_TRIGGER_TOKEN` check below is application-level defense in depth, not a
  // substitute for the IAM grant. Unset token (the default) rejects all HTTP-triggered
  // fetches rather than defaulting to open (spec: on-demand trigger design).
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — comment-only change, no type surface changes.

- [ ] **Step 3: Run the existing handler tests to confirm no regression**

Run: `npm test -- tests/handler.test.ts`
Expected: PASS — every existing test still passes; we have not altered any behavior, only a comment.

- [ ] **Step 4: Commit**

```bash
git add src/handler.ts
git commit -m "docs(handler): clarify SIGv4 boundary on HTTP-triggered fetch gate"
```

---

## Task 3: Add `tests/infra.test.ts` CDK synth suite for the IAM auth on the Function URL

**Files:**
- Create: `tests/infra.test.ts`

This task runs first because the synth suite pins the wire-shape change from Task 1 (AuthType, both invocation permissions). The smoke harness in Task 4 depends on the URL grant existing.

- [ ] **Step 1: Write the failing synth suite**

Create `tests/infra.test.ts` with the following content:

```typescript
// tests/infra.test.ts
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AgentStack } from '../infra/stack.js';

describe('AgentStack Function URL auth', () => {
  it('synthesizes an AWS::Lambda::Url with AuthType AWS_IAM and pins the URL grants + EventBridge state', () => {
    // Deterministic synth environment — never deploys.
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/webhook';

    const app = new App();
    const stack = new AgentStack(app, 'SqliteS3AgentTutorial', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    // 1. AWS::Lambda::Url exists with AuthType: AWS_IAM and points at the deployed function.
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
      TargetFunctionArn: { 'Fn::GetAtt': ['AgentFunction1E1F4F0F', 'Arn'] },
    });

    // 2. lambda:InvokeFunctionUrl permission with same-account principal + AuthType scoped.
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: '123456789012',
      FunctionUrlAuthType: 'AWS_IAM',
    });

    // 3. lambda:InvokeFunction permission with same-account principal + InvokedViaFunctionUrl.
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: '123456789012',
      InvokedViaFunctionUrl: true,
    });

    // 4. EventBridge rule still ENABLED with the 5-minute cadence (unchanged).
    template.hasResourceProperties('AWS::Events::Rule', {
      State: 'ENABLED',
      ScheduleExpression: 'rate(5 minutes)',
    });

    // 5. The two stack outputs the smoke + loop scripts depend on still exist.
    template.hasOutput('LoopRuleName', {});
    template.hasOutput('AgentFunctionUrl', {});
  });
});
```

Note on identifying the function logical id: the CDK assigns `AgentFunction1E1F4F0F` based on the construct path; if the assertion errors on that exact string, the implementation step below shows how to capture it generically with `objectLike` instead.

- [ ] **Step 2: Run the test to verify it fails (red)**

Run: `npm test -- tests/infra.test.ts`
Expected: FAIL — the existing stack synthesizes `AuthType: NONE` (no `AWS_IAM`), no `FunctionUrlAuthType`/`InvokedViaFunctionUrl` permissions exist yet. The exact assertion that fails first is the `AWS::Lambda::Url` `AuthType: 'AWS_IAM'` check.

- [ ] **Step 3: If the `TargetFunctionArn` logical-id assertion is fragile, switch to a generic capture**

If the function's logical id ever drifts (CDK replaces the `1E1F4F0F` hash), replace the `AWS::Lambda::Url` assertion body in Step 1 with:

```typescript
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
      TargetFunctionArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] },
    });
```

…adding `import { Match } from 'aws-cdk-lib/assertions';` at the top of the file (the same module `Template` comes from). (Generic capture is the recommended long-term shape — the CDK logical id is internal.)

- [ ] **Step 4: Re-run after Task 1 is in place to confirm the suite goes green**

Wait — Task 1 must be implemented first for this to pass. Order of execution: Task 1 Step 1 has already been written; if the implementer is running tasks in order, by the time this test is run for real the stack change is in place. If running this task in isolation, run Task 1 first, then return here.

Run: `npm test -- tests/infra.test.ts`
Expected: PASS — every assertion holds against the new synth output.

- [ ] **Step 5: Commit**

```bash
git add tests/infra.test.ts
git commit -m "test(infra): pin Function URL AWS_IAM auth + URL grants via synth"
```

---

## Task 4: Rewrite `scripts/smoke.sh` as a read-only status probe

**Files:**
- Modify: `scripts/smoke.sh` (full rewrite)

This is the bulk of the change. The file is rewritten end-to-end; the comment blocks explaining each branch are part of the script (the script doubles as documentation in this repo).

- [ ] **Step 1: Verify the harness scaffolding is correct before rewriting the script**

Read `scripts/smoke.sh` end-to-end once more to confirm the variables being preserved (credential netrc flow, `trap` cleanup, `set -euo pipefail`) match what Task 5's harness shims will need to observe. Anything the harness asserts on must be a real branch in the script.

- [ ] **Step 2: Replace `scripts/smoke.sh` with the read-only probe**

Replace the entire contents of `scripts/smoke.sh` with:

```bash
#!/usr/bin/env bash
# Read-only status probe (smoke-status-iam design §3.2). Never invokes the deployed
# function, never posts to Discord, never calls Bedrock. Proves two things:
#
#   1. The Function URL actually enforces AWS_IAM — an unsigned status POST must
#      return 403. If it returns 200, the URL has been misconfigured back to
#      authType: NONE and the tutorial is no longer teaching what it claims to.
#
#   2. An authorized same-account principal can read the status — a SigV4-signed
#      status POST must return 200 with the documented shape. The signed probe
#      retries 429s only (Lambda's reservedConcurrentExecutions: 1 mutex while a
#      loop tick is in flight) within a bounded window; any other non-2xx fails
#      immediately.
#
# Tolerates the deployed function's reservedConcurrentExecutions: 1 mutex, so it
# can run any time — including while a 5-minute loop tick is in flight.
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

# Retry window for the signed probe — bounded to ~75 s, longer than the deployed
# Lambda's 60 s timeout plus a small margin. Each iteration sleeps RETRY_DELAY
# seconds before the next attempt.
RETRY_DELAY=5
RETRY_MAX_SECONDS=75

# Sensitive material lives in 0600 temp files (not argv, visible in `ps aux`):
#   NETRC_FILE               — access key + secret access key (curl --netrc-file)
#   SECURITY_TOKEN_HEADER_FILE — X-Amz-Security-Token (SSO / assumed-role sessions)
# `mktemp` gives a per-invocation path; `trap` cleans up so a failure mid-run
# doesn't leave credentials on disk.
NETRC_FILE=$(mktemp)
SECURITY_TOKEN_HEADER_FILE=""
chmod 600 "$NETRC_FILE"
trap 'rm -f "$NETRC_FILE" ${SECURITY_TOKEN_HEADER_FILE:+"$SECURITY_TOKEN_HEADER_FILE"}' EXIT

echo "=== Resolving Function URL ==="
OUTPUTS=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output json)

FUNCTION_URL=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey == "AgentFunctionUrl") | .OutputValue')
if [ -z "$FUNCTION_URL" ] || [ "$FUNCTION_URL" = "null" ]; then
  echo "FAIL: stack $STACK_NAME has no AgentFunctionUrl output — re-run \`npm run deploy\`" >&2
  exit 1
fi
echo "Function URL: $FUNCTION_URL"

echo ""
echo "=== Probing unsigned access (must be 403) ==="
# Capture only the HTTP status; the body is irrelevant for the 403 assertion and
# a public-URL regression would still show the right status code. Connect and
# transfer timeouts bound the wait so a hung DNS / TCP handshake can't keep
# smoke.sh frozen. The `if ! ...; then` block turns a curl transport error
# into an actionable failure instead of `set -e` aborting silently inside the
# command substitution.
if ! UNSIGNED_STATUS=$(curl -s -o /dev/null --connect-timeout 5 --max-time 10 \
  -w '%{http_code}' \
  -X POST \
  --header 'Content-Type: application/json' \
  --data '{"op":"status"}' \
  --show-error \
  "$FUNCTION_URL"); then
  echo "FAIL: unsigned status probe could not reach $FUNCTION_URL (curl transport error). Check your network and AWS_REGION." >&2
  exit 1
fi
echo "Unsigned status: $UNSIGNED_STATUS"
if [ "$UNSIGNED_STATUS" != "403" ]; then
  echo "FAIL: unsigned status probe returned $UNSIGNED_STATUS; Function URL is not enforcing AWS_IAM. Re-check infra/stack.ts (authType must be AWS_IAM, and \`functionUrl.grantInvokeUrl\` must be wired)." >&2
  exit 1
fi

echo ""
echo "=== Resolving AWS credentials for SigV4 signing ==="
# `aws configure export-credentials --format process` resolves through the full
# AWS CLI credential chain (env vars, SSO, credential_process, etc.) — unlike
# `aws configure get`, which only reads the static profile file. When the
# resolved credentials include a SessionToken (SSO or assumed-role), curl needs
# it as `X-Amz-Security-Token` for SigV4 to accept the signature.
FUNCTION_HOST=$(echo "$FUNCTION_URL" | sed -E 's#^https?://([^/]+).*#\1#')
CREDENTIALS_JSON=$(aws configure export-credentials --profile "$PROFILE" --format process)
ACCESS_KEY=$(jq -r '.AccessKeyId' <<<"$CREDENTIALS_JSON")
SECRET_KEY=$(jq -r '.SecretAccessKey' <<<"$CREDENTIALS_JSON")
SESSION_TOKEN=$(jq -r '.SessionToken // empty' <<<"$CREDENTIALS_JSON")

printf 'machine %s login %s password %s\n' \
  "$FUNCTION_HOST" \
  "$ACCESS_KEY" \
  "$SECRET_KEY" \
  > "$NETRC_FILE"

CURL_HEADERS=(--header 'Content-Type: application/json')
if [ -n "$SESSION_TOKEN" ]; then
  SECURITY_TOKEN_HEADER_FILE=$(mktemp)
  chmod 600 "$SECURITY_TOKEN_HEADER_FILE"
  printf 'X-Amz-Security-Token: %s\n' "$SESSION_TOKEN" \
    > "$SECURITY_TOKEN_HEADER_FILE"
  CURL_HEADERS+=(--header "@$SECURITY_TOKEN_HEADER_FILE")
fi

echo ""
echo "=== Probing signed access (retry 429s only) ==="
# The deployed function has reservedConcurrentExecutions: 1, so a loop tick in
# flight causes the URL to return 429. We retry only 429s for RETRY_MAX_SECONDS;
# any other non-2xx (signed 403 = bad IAM grant, 5xx = real failure) fails
# immediately. `STATUS_BODY_FILE` is captured so the schema check can read it.
STATUS_BODY_FILE=$(mktemp)
trap 'rm -f "$NETRC_FILE" ${SECURITY_TOKEN_HEADER_FILE:+"$SECURITY_TOKEN_HEADER_FILE"} "$STATUS_BODY_FILE"' EXIT

DEADLINE=$(( $(date +%s) + RETRY_MAX_SECONDS ))
ATTEMPT=0
STATUS_CODE=""
while :; do
  ATTEMPT=$((ATTEMPT + 1))
  # Cap each attempt's --max-time to the remaining retry budget so one attempt
  # cannot extend the 75-second window. Floor at 1 to avoid a zero/negative
  # --max-time on the final iteration.
  REMAINING=$(( DEADLINE - $(date +%s) ))
  if [ "$REMAINING" -lt 1 ]; then REMAINING=1; fi
  if ! STATUS_CODE=$(curl -s -o "$STATUS_BODY_FILE" -w '%{http_code}' \
    --connect-timeout 5 --max-time "$REMAINING" \
    --aws-sigv4 "aws:amz:$REGION:lambda" \
    --netrc-file "$NETRC_FILE" \
    "${CURL_HEADERS[@]}" \
    --data '{"op":"status"}' \
    --show-error \
    "$FUNCTION_URL"); then
    echo "FAIL: signed status probe could not reach $FUNCTION_URL (curl transport error). Check your network and AWS_REGION." >&2
    exit 1
  fi
  echo "Attempt $ATTEMPT: status $STATUS_CODE"
  if [ "$STATUS_CODE" = "200" ]; then
    break
  fi
  if [ "$STATUS_CODE" != "429" ]; then
    echo "FAIL: signed status probe returned $STATUS_CODE (expected 200 after retries). The Function URL grant may be missing — re-run \`npm run deploy\` so \`functionUrl.grantInvokeUrl\` is in place, and verify your IAM principal has lambda:InvokeFunctionUrl / lambda:InvokeFunction on the URL." >&2
    exit 1
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "FAIL: signed status probe returned 429 for the full $RETRY_MAX_SECONDS-second retry window. Lambda concurrency contention is the most likely cause — the deployed function has reservedConcurrentExecutions: 1 and a loop tick is currently in flight. See scripts/loop-start.sh / scripts/loop-stop.sh, or raise RESERVED_CONCURRENCY and redeploy." >&2
    exit 1
  fi
  sleep "$RETRY_DELAY"
done

echo ""
echo "=== Validating status schema ==="
# Empty-state response (before the first loop tick) is valid:
#   {"snapshotVersion": null, "sources": [], "recentNotifications": []}
# Populated responses must include a weather source with a non-null lastValue —
# the smoke test proves the loop has actually produced a snapshot, not just
# that the URL grant works.
#
# One schema predicate covers object shape, field presence, and array types —
# snapshotVersion is string-or-null (the empty-state marker), and the two
# collection fields are arrays. This rejects shape regressions like
# `{"snapshotVersion":42,"sources":{...},"recentNotifications":"invalid"}`
# which the previous `has()` + per-field read would have accepted.
if ! jq -e '
  type == "object"
  and has("snapshotVersion")
  and (.snapshotVersion == null or (.snapshotVersion | type) == "string")
  and has("sources") and ((.sources | type) == "array")
  and has("recentNotifications")
  and ((.recentNotifications | type) == "array")
' "$STATUS_BODY_FILE" >/dev/null 2>&1; then
  echo "FAIL: signed status response is not a valid status object (snapshotVersion string|null, sources + recentNotifications arrays required)" >&2
  cat "$STATUS_BODY_FILE" >&2
  exit 1
fi

# Read snapshotVersion without collapsing null so the empty-state branch below
# can still recognize it. `jq -r` renders null as `null`, which is the value
# the next branch compares against.
SNAPSHOT_VERSION=$(jq -r '.snapshotVersion' "$STATUS_BODY_FILE")

WEATHER_LAST_VALUE=$(jq -r '.sources[] | select(.name == "weather") | .lastValue // empty' "$STATUS_BODY_FILE")
if [ -n "$WEATHER_LAST_VALUE" ] && [ "$WEATHER_LAST_VALUE" != "null" ]; then
  echo "Weather source lastValue: $WEATHER_LAST_VALUE"
else
  if [ "$SNAPSHOT_VERSION" = "null" ]; then
    echo "Empty-state response (snapshotVersion: null) — loop has not produced a snapshot yet, which is valid before the first tick."
  else
    echo "FAIL: snapshotVersion is $SNAPSHOT_VERSION but no weather source with a non-null lastValue was found in the status response" >&2
    cat "$STATUS_BODY_FILE" >&2
    exit 1
  fi
fi

echo ""
echo "=== Smoke test complete ==="
```

Make the file executable:

```bash
chmod +x scripts/smoke.sh
```

- [ ] **Step 3: Sanity-check the script syntax**

Run: `bash -n scripts/smoke.sh`
Expected: exits 0, no output.

- [ ] **Step 4: Commit the script alone (so the harness test in Task 5 can target it)**

```bash
git add scripts/smoke.sh
git commit -m "feat(smoke): rewrite as read-only IAM-authenticated status probe"
```

---

## Task 5: Add `tests/smoke.test.ts` deterministic shell harness for `scripts/smoke.sh`

**Files:**
- Create: `tests/smoke.test.ts`

This harness is the regression gate that pins the read-only invariant. It runs `bash scripts/smoke.sh` in a subprocess with stubbed `aws`, `curl`, and `sleep` on a temp `PATH`, observes the call log, and asserts behavior on every branch the spec enumerates.

- [ ] **Step 1: Write the failing test suite**

The harness curl shim mimics `-o <file> -w '%{http_code}'`: it scans argv for `-o` followed by a path, writes the body to that path, then writes the format-string output (status code) to stdout. Without this, the script's `$STATUS_BODY_FILE` would be empty and the schema-validation tests could not exercise the populated/empty-state branches.

Create `tests/smoke.test.ts` with:

```typescript
// tests/smoke.test.ts
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The package is type: "module" (ESM), so `__dirname` is undefined when this
// file is evaluated. Derive the module directory from `import.meta.url`
// instead, which is the canonical ESM-compatible path.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SMOKE_SCRIPT = join(REPO_ROOT, 'scripts', 'smoke.sh');

/** A single scripted binary: each invocation appends `args` to a log file and
 *  exits with a code/body the harness pre-configured. */
type Shim = (args: string[]) => number;

interface ShimSpec {
  aws: Shim;
  curl: Shim;
  sleep: Shim;
}

interface ShimEnv {
  dir: string;
  binDir: string;
  originalPath: string;
  originalCwd: string;
  logPath: string;
}

function setupShims(): ShimEnv {
  const dir = mkdtempSync(join(tmpdir(), 'agent-smoke-shim-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(dir, 'invocations.log');
  writeFileSync(logPath, '');

  // Each shim is a thin bash wrapper that records its argv to a shared log file
  // and then delegates to a per-scenario behavior fragment. Args are JSON-encoded
  // via jq -Rsa so spaces, newlines, and JSON round-trip cleanly. The behavior
  // file is identified by the shim name from the dispatch wrapper.
  const shimBody = (name: string) => `#!/usr/bin/env bash
set -e
echo "\$(date +%s%N) ${name} \$(printf '%s' "\$*" | jq -Rsa .)" >> '${logPath}'
if [ -n "\${SHIM_BEHAVIOR_FILE_DIR:-}" ] && [ -d "\${SHIM_BEHAVIOR_FILE_DIR}" ]; then
  behavior="\${SHIM_BEHAVIOR_FILE_DIR}/${name}.sh"
  if [ -f "\$behavior" ]; then
    bash "\$behavior" "\$@"
    exit \$?
  fi
fi
echo "FAIL: shim ${name} invoked without SHIM_BEHAVIOR_FILE" >&2
exit 99
`;

  for (const name of ['aws', 'curl', 'sleep']) {
    const path = join(binDir, name);
    writeFileSync(path, shimBody(name));
    chmodSync(path, 0o755);
  }

  return {
    dir,
    binDir,
    originalPath: process.env.PATH ?? '',
    originalCwd: process.cwd(),
    logPath,
  };
}

/** Generates the post-log body for a shim. The shim's behavior is encoded as a
 *  JS function and inlined as a heredoc so the harness can mutate per-test
 *  state (status codes, body files, retry counters) without restarting the
 *  test runner. */
function shimSource(name: string, shim: Shim): string {
  // We pass the shim's behavior through a marker file the test writes.
  // Each shim reads ${SHIM_BEHAVIOR_FILE} (an executable script fragment) and
  // evaluates it after logging. The harness writes the fragment per test
  // scenario; see `setupShimsForScenario` below.
  return `if [ -n "\${SHIM_BEHAVIOR_FILE:-}" ] && [ -f "\${SHIM_BEHAVIOR_FILE}" ]; then
  bash "\${SHIM_BEHAVIOR_FILE}" "\${name}" "\$*"
else
  echo "FAIL: shim ${name} invoked without SHIM_BEHAVIOR_FILE" >&2
  exit 99
fi`;
}

/** Writes a behavior fragment for one shim. The fragment is sourced as bash and
 *  receives the shim's name as $1 and full argv as $2+. */
function setShimBehavior(env: ShimEnv, name: string, fragment: string): void {
  writeFileSync(join(env.dir, `${name}.sh`), fragment);
}

function runSmoke(env: ShimEnv, extraEnv: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync('bash', [SMOKE_SCRIPT], {
    env: {
      ...process.env,
      // Put the shim binDir FIRST so the mocked `aws`/`curl`/`sleep` win over
      // the real binaries; keep the rest of PATH so bash, jq, mktemp, etc. are
      // still findable. Timeout is 120s so the retry-exhaustion test can run
      // its full 75-second budget without the harness killing it.
      PATH: `${env.binDir}:${env.originalPath}`,
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'default',
      SHIM_BEHAVIOR_FILE_DIR: env.dir,
      ...extraEnv,
    },
    cwd: env.originalCwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

function parseInvocations(env: ShimEnv): Array<{ name: string; args: string }> {
  const text = readFileSync(env.logPath, 'utf8').trim();
  if (text === '') return [];
  return text.split('\n').map((line) => {
    // Format: <ns-timestamp> <shim-name> <json-encoded-args>
    const firstSpace = line.indexOf(' ');
    const secondSpace = line.indexOf(' ', firstSpace + 1);
    const name = line.slice(firstSpace + 1, secondSpace);
    const argsJson = line.slice(secondSpace + 1);
    return { name, args: JSON.parse(argsJson) as string };
  });
}

/** Each fragment sets SHIM_BEHAVIOR_FILE to its own path before delegating, so
 *  every shim call resolves to the right script. */
function withBehaviorFile(env: ShimEnv, body: string): string {
  return `export SHIM_BEHAVIOR_FILE="\${SHIM_BEHAVIOR_FILE_DIR}/\${1}.sh"
shift
bash "\${SHIM_BEHAVIOR_FILE}" "\${1}" "\${@}"
exit $?`;
}

/** Writes the per-shim dispatch wrapper and the per-scenario behavior fragments
 *  for `aws`, `curl`, and `sleep`. */
function installScenario(env: ShimEnv, scenario: Scenario): void {
  setShimBehavior(env, 'aws', withBehaviorFile(env, scenario.aws));
  setShimBehavior(env, 'curl', withBehaviorFile(env, scenario.curl));
  setShimBehavior(env, 'sleep', withBehaviorFile(env, scenario.sleep));
}

interface Scenario {
  aws: string;
  curl: string;
  sleep: string;
}

/** Helper: builds an `aws cloudformation describe-stacks` response that yields
 *  a single AgentFunctionUrl output. */
const stackDescribeOk = `
if [ "\${1}" = "cloudformation" ] && [ "\${2}" = "describe-stacks" ]; then
  echo '[{"OutputKey":"AgentFunctionUrl","OutputValue":"https://abc.lambda-url.us-east-1.on.aws/"}]'
  exit 0
fi
if [ "\${1}" = "configure" ] && [ "\${2}" = "export-credentials" ]; then
  echo '{"AccessKeyId":"AKIAEXAMPLE","SecretAccessKey":"secretexample"}'
  exit 0
fi
echo "unexpected aws call: \$*" >&2
exit 1
`;

describe('scripts/smoke.sh — read-only status probe', () => {
  let env: ShimEnv;

  beforeAll(() => {
    // Surface a script syntax error immediately so it never masquerades as a
    // harness failure on a real run.
    const syntax = spawnSync('bash', ['-n', SMOKE_SCRIPT], { encoding: 'utf8' });
    if (syntax.status !== 0) {
      throw new Error(`bash -n scripts/smoke.sh failed:\n${syntax.stderr}`);
    }
  });

  beforeEach(() => {
    // Defaults are overridden per test via installScenario.
  });

  afterEach(() => {
    if (env) {
      process.env.PATH = env.originalPath;
      process.chdir(env.originalCwd);
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('unsigned probe returns 403; signed probe returns 200 with empty-state body; exit 0', () => {
    env = setupShims({} as never);
    installScenario(env, {
      aws: stackDescribeOk,
      curl: `
# ${'$'}{1} == method flag handling is irrelevant — script uses --header / --data.
# Find the request by URL.
url="\${@: -1}"
if [[ "\${url}" != *".lambda-url."* ]]; then echo "unexpected curl url \$url" >&2; exit 1; fi
# Distinguish unsigned vs signed by presence of --aws-sigv4
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  echo '{"snapshotVersion":null,"sources":[],"recentNotifications":[]}'
  exit 200   # treated by spawnSync as success; the script captures %{http_code} via -w
else
  echo ''
  exit 0
fi
`,
      sleep: 'exit 0',
    });
    // Override curl's exit code via wrapper: have curl emit '403' or '200' in -w.
    // Simplification: rewrite curl's source to use -w with status codes.
    setShimBehavior(env, 'curl', withBehaviorFile(env, `
# Mimic curl's -o <file> -w '%{http_code}': scan argv for the file path, write
# the body there, write the status code to stdout.
outfile=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-o" ]; then outfile="\$a"; fi
  prev="\$a"
done
write_body_and_code() {
  local body="\$1" code="\$2"
  if [ -n "\$outfile" ]; then printf '%s' "\$body" > "\$outfile"; fi
  printf '%s' "\$code"
}
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '{"snapshotVersion":null,"sources":[],"recentNotifications":[]}' '200'
else
  write_body_and_code '' '403'
fi
exit 0
`));

    const result = runSmoke(env);

    expect(result.status).toBe(0);
    const calls = parseInvocations(env);
    // Exactly two curl probes in order: the unsigned one first (asserts the
    // AWS_IAM boundary), then the signed one (asserts the read path). A
    // regression that signs both requests, or removes the unsigned probe,
    // would still pass `calls.some((c) => c.name === 'curl')` — the stricter
    // call-order + signing checks below pin that gap shut.
    const curlCalls = calls.filter((c) => c.name === 'curl');
    expect(curlCalls).toHaveLength(2);
    expect(curlCalls[0].args.includes('--aws-sigv4')).toBe(false);
    expect(curlCalls[1].args.includes('--aws-sigv4')).toBe(true);
    // Read-only invariant: aws is only ever invoked with describe-stacks /
    // export-credentials, NEVER with `lambda invoke` and never with the literal
    // fetch payload.
    const fetchInvocations = calls.filter((c) => c.name === 'aws' && c.args.includes('lambda invoke'));
    expect(fetchInvocations).toEqual([]);
    const fetchPayloads = calls.filter((c) => c.args.includes('{"op":"fetch"}'));
    expect(fetchPayloads).toEqual([]);
  });

  it('unsigned probe returns 403; signed probe returns 429 twice, then 200; exit 0 with retry log', () => {
    env = setupShims({} as never);
    let curlAttempts = 0;
    const curlFragment = `
url="\${@: -1}"
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  curlAttempts=\$((curlAttempts + 1))
  if [ "\$curlAttempts" -le 2 ]; then
    printf ''
    printf '429'
  else
    printf '{"snapshotVersion":"v1","sources":[{"name":"weather","lastValue":"72F"}],"recentNotifications":[]}'
    printf '200'
  fi
else
  printf ''
  printf '403'
fi
exit 0
`;
    // The shim is invoked as `bash <behaviorFile> curl <args...>`. We can't share
    // bash state across calls (each is a fresh process), so the counter lives in
    // a file in env.dir.
    const counterFile = join(env.dir, 'curl-attempts');
    writeFileSync(counterFile, '0');
    setShimBehavior(env, 'curl', withBehaviorFile(env, `
outfile=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-o" ]; then outfile="\$a"; fi
  prev="\$a"
done
write_body_and_code() {
  local body="\$1" code="\$2"
  if [ -n "\$outfile" ]; then printf '%s' "\$body" > "\$outfile"; fi
  printf '%s' "\$code"
}
counter="\${SHIM_BEHAVIOR_FILE_DIR}/curl-attempts"
n=\$(cat "\$counter")
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  n=\$((n + 1))
  echo "\$n" > "\$counter"
  if [ "\$n" -le 2 ]; then
    write_body_and_code '' '429'
  else
    write_body_and_code '{"snapshotVersion":"v1","sources":[{"name":"weather","lastValue":"72F"}],"recentNotifications":[]}' '200'
  fi
else
  write_body_and_code '' '403'
fi
exit 0
`));
    setShimBehavior(env, 'aws', withBehaviorFile(env, stackDescribeOk));
    setShimBehavior(env, 'sleep', withBehaviorFile(env, 'exit 0'));

    const result = runSmoke(env);

    expect(result.status).toBe(0);
    const signedCurlCalls = parseInvocations(env).filter(
      (c) => c.name === 'curl' && c.args.includes('--aws-sigv4'),
    );
    // 2 retries (429 each) + 1 success (200) = 3 signed probes.
    expect(signedCurlCalls).toHaveLength(3);
  });

  it('signed probe returns 429 for the full retry window; script fails with bounded-retry message', () => {
    env = setupShims({} as never);
    setShimBehavior(env, 'curl', withBehaviorFile(env, `
outfile=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-o" ]; then outfile="\$a"; fi
  prev="\$a"
done
write_body_and_code() {
  local body="\$1" code="\$2"
  if [ -n "\$outfile" ]; then printf '%s' "\$body" > "\$outfile"; fi
  printf '%s' "\$code"
}
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '' '429'
else
  write_body_and_code '' '403'
fi
exit 0
`));
    setShimBehavior(env, 'aws', withBehaviorFile(env, stackDescribeOk));
    // sleep should be invoked by the retry loop; let it pass through quickly
    setShimBehavior(env, 'sleep', withBehaviorFile(env, 'exit 0'));

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/429/);
    expect(result.stderr).toMatch(/RESERVED_CONCURRENCY|reservedConcurrentExecutions|loop/);
  });

  it('signed probe returns 403; script fails with IAM-grant message', () => {
    env = setupShims({} as never);
    setShimBehavior(env, 'curl', withBehaviorFile(env, `
outfile=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-o" ]; then outfile="\$a"; fi
  prev="\$a"
done
write_body_and_code() {
  local body="\$1" code="\$2"
  if [ -n "\$outfile" ]; then printf '%s' "\$body" > "\$outfile"; fi
  printf '%s' "\$code"
}
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '' '403'
else
  write_body_and_code '' '403'
fi
exit 0
`));
    setShimBehavior(env, 'aws', withBehaviorFile(env, stackDescribeOk));
    setShimBehavior(env, 'sleep', withBehaviorFile(env, 'exit 0'));

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lambda:InvokeFunctionUrl|URL grant|grantInvokeUrl/);
  });

  it('unsigned probe returns 200; script fails with URL-is-public regression message', () => {
    env = setupShims({} as never);
    setShimBehavior(env, 'curl', withBehaviorFile(env, `
outfile=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-o" ]; then outfile="\$a"; fi
  prev="\$a"
done
write_body_and_code() {
  local body="\$1" code="\$2"
  if [ -n "\$outfile" ]; then printf '%s' "\$body" > "\$outfile"; fi
  printf '%s' "\$code"
}
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '{}' '200'
else
  write_body_and_code '' '200'
fi
exit 0
`));
    setShimBehavior(env, 'aws', withBehaviorFile(env, stackDescribeOk));
    setShimBehavior(env, 'sleep', withBehaviorFile(env, 'exit 0'));

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/AWS_IAM|authType|infra\/stack\.ts/);
  });

  it('signed probe returns 200 with populated body missing weather.lastValue; script fails with field-missing message', () => {
    env = setupShims({} as never);
    setShimBehavior(env, 'curl', withBehaviorFile(env, `
outfile=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-o" ]; then outfile="\$a"; fi
  prev="\$a"
done
write_body_and_code() {
  local body="\$1" code="\$2"
  if [ -n "\$outfile" ]; then printf '%s' "\$body" > "\$outfile"; fi
  printf '%s' "\$code"
}
if [[ " \$* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '{"snapshotVersion":"v1","sources":[],"recentNotifications":[]}' '200'
else
  write_body_and_code '' '403'
fi
exit 0
`));
    setShimBehavior(env, 'aws', withBehaviorFile(env, stackDescribeOk));
    setShimBehavior(env, 'sleep', withBehaviorFile(env, 'exit 0'));

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/weather|lastValue/);
  });
});
```

A few notes on the harness shape, to clarify decisions the implementer may otherwise second-guess:

- **The shim is a thin `bash` wrapper, not a Node script.** The harness appends to a log file using `jq -Rsa` so argv round-trips cleanly (newlines, embedded spaces, JSON). Behavior is delegated to per-shim fragments under `SHIM_BEHAVIOR_FILE_DIR/<name>.sh` so each scenario can rewrite curl's response without touching the dispatcher.
- **`%{http_code}` semantics + `-o <file>`.** Real `curl -o <file> -w '%{http_code}'` writes the body to the file and the format-string output to stdout. The shim scans argv for `-o` and the path that follows, writes the body to that path, then writes the status code to stdout. This lets the script's `$STATUS_BODY_FILE=$(mktemp)` flow work end-to-end under the harness, so the schema-validation tests can exercise the empty-state vs populated branches.
- **The retry test uses a counter file** under `env.dir` because each shim invocation is a fresh `bash` process — function-local variables can't carry across calls.
- **All tests assert the read-only invariant** at the end: no `aws lambda invoke` call, no `{"op":"fetch"}` payload anywhere in the invocation log. This is the regression-sensitive assertion the spec explicitly demands.

- [ ] **Step 2: Run the test suite — first run may show environment issues, fix in place**

Run: `npm test -- tests/smoke.test.ts`
Expected: PASS for the syntax-check `beforeAll`. The scenario tests may fail on first run due to subtle shell-escaping issues (the shim fragments use a mix of `\$` for fragment-level escape and `${...}` for runtime substitution); the implementer should iterate, keeping the spec's behavior matrix as the contract. The `bash -n` assertion in `beforeAll` already pins script syntax separately.

If a scenario fails with "unexpected curl url" or "shim X invoked without SHIM_BEHAVIOR_FILE", the dispatcher wrapper is broken — `SHIM_BEHAVIOR_FILE_DIR` is not propagating. Verify `runSmoke` sets it in the env.

- [ ] **Step 3: Run the full vitest suite to confirm no regressions**

Run: `npm test`
Expected: PASS — every existing suite plus the two new ones (`tests/infra.test.ts`, `tests/smoke.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add tests/smoke.test.ts
git commit -m "test(smoke): deterministic shell harness for read-only status probe"
```

---

## Task 6: Document the change in README, architecture, rehydration, and budget-protection docs

**Files:**
- Modify: `README.md`
- Modify: `docs/01-architecture.md`
- Modify: `docs/02-rehydration.md`
- Modify: `docs/07-budget-protection.md`

Per the project's feedback memory ("small features get a README mention, not a new docs/0X-*.md"), no new tutorial chapter is added.

- [ ] **Step 1: Update README.md**

In `README.md`:

- In the Quick start block (`README.md:23-36`), append a single sentence to the line ending in `npm run smoke` (the line just after the deploy block, currently `npm run smoke`):

```
`npm run smoke` is read-only and safe to run any time, including while a loop tick is in flight — it never invokes `fetch`, never posts to Discord, and never calls Bedrock. It probes the status Function URL with SigV4 and asserts the URL actually requires it.
```

- In the "Loop mode" section (`README.md:46-73`), append a single sentence at the end of the section (just before `## Triggering a fetch on demand`):

```
To verify the reader side of the loop (no Discord post, no Bedrock call), run `npm run smoke` — it checks the status endpoint and confirms it is SigV4-protected.
```

- In the "Triggering a fetch on demand" section (`README.md:75-90`), update the opening paragraph to mention IAM:

Replace `README.md:77-80`:

```markdown
The daily `fetch` run is normally EventBridge's job, but you can also trigger one over
HTTP via the same Function URL the `status` op uses. The Function URL is locked to
AWS_IAM — your CLI credentials must be authorized against the same-account URL grant
the stack synthesizes (smoke-status-iam design §3.1) before the request reaches the
handler. This is off by default — set `FETCH_TRIGGER_TOKEN` before deploying (`export
FETCH_TRIGGER_TOKEN=...` before `npm run deploy`, alongside `DISCORD_WEBHOOK_URL`), then:
```

- [ ] **Step 2: Update `docs/01-architecture.md`**

In `docs/01-architecture.md:1-10`, replace the opening paragraph to describe the Function URL as IAM-authenticated:

Replace the current opening paragraph (the four lines beginning with `One Lambda function. Two operations...`) with:

```markdown
One Lambda function. Two operations, read as `event.op`: `fetch` (the writer, run on a 5-minute EventBridge schedule) and `status` (the reader, exposed by a Function URL locked to `authType: AWS_IAM`). Both read and write the same single SQLite file that lives durably in one S3 object, but each keeps its own transient copy in `/tmp` for the lifetime of the execution environment: the writer at `${DB_PATH}` (default `/tmp/memory.db`), the reader at `${DB_PATH}.reader` (default `/tmp/memory.db.reader`). Warm Lambda invocations share that `/tmp`, which is exactly what lets the status reader reuse its cached database handle (see [docs/02-rehydration.md](02-rehydration.md)); cold starts discard it and rehydrate from S3.

The Function URL's `AWS_IAM` auth means a status read (or the on-demand HTTP fetch trigger) requires a SigV4-signed request from a principal the stack grants access to — by default, any principal in the deploying account. The on-demand `FETCH_TRIGGER_TOKEN` documented in the README is an application-level defense-in-depth check layered on top of that IAM grant, not a substitute for it.
```

- [ ] **Step 3: Update `docs/02-rehydration.md`**

In `docs/02-rehydration.md:41-58` (the "Version-cached reads" section), add a paragraph after the first paragraph noting the SigV4 framing:

After the first paragraph (the one ending `...against an unchanged snapshot.`), insert:

```markdown
The reader is reached via the Function URL, which `infra/stack.ts` locks to `authType: AWS_IAM` and grants to the deploying account. A status read therefore requires a SigV4-signed request from a same-account principal — `curl` without signing (or a browser, which can't sign) gets `403` from the URL itself before the handler ever runs. The retry-aware `npm run smoke` is the tutorial's end-to-end check that both halves of this hold: the unsigned probe returns `403`, the signed probe returns `200` with the documented schema.
```

- [ ] **Step 4: Update `docs/07-budget-protection.md`**

In `docs/07-budget-protection.md:10-15` (the "A leaked or brute-forced `FETCH_TRIGGER_TOKEN`" bullet), expand the bullet to mention IAM:

Replace the bullet:

```markdown
- **A leaked or brute-forced `FETCH_TRIGGER_TOKEN`.** The on-demand HTTP fetch trigger
  (`?op=fetch&token=...` on the Function URL — see the README's Quick start) runs a real
  Bedrock call and a real Discord post per request. Anyone with a valid token can invoke it
  as often as the Lambda's `reservedConcurrentExecutions: 1` allows — sequentially, but
  with no rate limit otherwise.
```

With:

```markdown
- **A leaked or brute-forced `FETCH_TRIGGER_TOKEN` *combined with* an authorized IAM
  principal.** The on-demand HTTP fetch trigger
  (`?op=fetch&token=...` on the Function URL — see the README's Quick start) runs a real
  Bedrock call and a real Discord post per request. Reaching the handler at all now
  requires SigV4-signing from a principal the stack's URL grant covers
  (`functionUrl.grantInvokeUrl` in `infra/stack.ts` — same account by default); the
  token alone is no longer sufficient. With both in hand, an attacker can invoke as
  often as the Lambda's `reservedConcurrentExecutions: 1` allows — sequentially, but with
  no rate limit otherwise.
```

- [ ] **Step 5: Verify the doc updates render cleanly (no broken links / anchors)**

Run: `grep -nE '\bcurl or browser\b|\bpublic URL\b|\breachable by anyone\b' README.md docs/01-architecture.md docs/02-rehydration.md docs/07-budget-protection.md src/handler.ts`
Expected: no matches — every "public URL" / "reachable by anyone" / "curl or browser" phrasing has been replaced.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/01-architecture.md docs/02-rehydration.md docs/07-budget-protection.md
git commit -m "docs: describe Function URL as IAM-authenticated + smoke is read-only"
```

---

## Task 7: Final repository verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test, typecheck, build matrix**

Run in order:

```bash
npm test
npm run typecheck
npm run build
```

Expected: PASS for all three. The full vitest run includes both new suites (`tests/infra.test.ts`, `tests/smoke.test.ts`) plus every pre-existing suite. `typecheck` and `build` should be clean — no new types introduced.

- [ ] **Step 2: Verify CDK synthesizes cleanly**

Run: `set -o pipefail; if synth=$(DISCORD_WEBHOOK_URL=https://discord.example/webhook npx cdk synth --app "npx tsx infra/app.ts" 2>&1 | head -20); then echo "synth ok"; else echo "$synth"; exit 1; fi`
Expected: a JSON-ish template output, no errors. Use `--app "npx tsx infra/app.ts"` because the project uses `tsx` for the CDK app entry, and `infra/app.ts` is the dedicated CLI entrypoint (the test/CDK import of `infra/stack.ts` has no side effects). The `if synth=$(...); then ... else echo $synth; exit 1; fi` pattern preserves the `cdk synth` exit status — `npx cdk synth ... | head -20` would otherwise return `head`'s status (always 0 once the pipe broke), hiding a failed synth. The `DISCORD_WEBHOOK_URL=...` prefix is the webhook the synth-time check in `infra/stack.ts` requires.

- [ ] **Step 3: Verify the script still parses**

Run: `bash -n scripts/smoke.sh && echo OK`
Expected: prints `OK`. The `tests/smoke.test.ts` `beforeAll` already runs this assertion, so a green vitest run implies this passed; this command is just a manual belt-and-suspenders check.

- [ ] **Step 4: Document the live post-deploy manual check in the commit message**

Do **not** run `npm run deploy` in this plan — that's an operator action gated on having AWS credentials and a Discord webhook URL. Instead, note in the final commit message that the operator-facing manual check (per design §5.3) is:

```bash
# After `npm run deploy`:
npm run smoke     # validates the empty-state read path (200, snapshotVersion: null)
# While a loop tick is in flight:
npm run smoke     # validates the 429 retry path (200 after retries)
```

Both runs perform zero writes, zero Discord posts, zero Bedrock calls.

- [ ] **Step 5: Final review against the acceptance criteria**

Walk the acceptance-criteria list from design §9 and confirm each item maps to a task:

| Acceptance criterion | Task |
|---|---|
| `bash -n scripts/smoke.sh` exits 0 | Task 4 Step 3 + Task 5 Step 1 (`beforeAll`) + Task 7 Step 3 |
| `npm test` passes including the new shell harness and CDK synth suite | Task 3 + Task 5 + Task 7 Step 1 |
| Shell harness asserts `403` on unsigned status requests | Task 5 Step 1 (test 1) |
| Shell harness verifies bounded retries on `429` and fails on retry exhaustion | Task 5 Step 1 (test 2 + test 3) |
| Shell harness accepts both `snapshotVersion: null` and populated `weather.lastValue` schemas | Task 5 Step 1 (test 1 covers empty; test 2 covers populated) |
| Shell harness asserts `aws lambda invoke` and the `fetch` payload are never sent | Task 5 Step 1 (every scenario asserts this) |
| CDK synth suite asserts `AuthType: AWS_IAM`, both URL invocation permissions, unchanged EventBridge | Task 3 Step 1 |
| `npm run typecheck`, `npm run build`, `cdk synth` complete cleanly | Task 7 Steps 1-2 |
| `npm run smoke` runs to completion immediately after `npm run deploy` (no fetch, `200` empty state, exit 0) | Task 4 Step 2 + Task 7 Step 4 (operator manual check, documented in commit) |
| README, `docs/01-architecture.md`, `docs/02-rehydration.md`, `docs/07-budget-protection.md` describe the URL as IAM-authenticated and note the on-demand token as defense in depth | Task 6 Steps 1-4 |

All ten acceptance criteria are covered. Stop here.

---

## Self-Review Notes

- **Spec coverage:** every section of the design doc is implemented. §3.1 → Task 1; §3.2 → Task 4; §3.3 (no handler changes beyond a comment) → Task 2; §4 (behavioral contract) → Task 4 (signed/unsigned branches, retry, schema) + Task 5 (harness pins every row of the table); §5.1 (shell harness) → Task 5; §5.2 (CDK synth assertions) → Task 3; §5.3 (repo verification) → Task 7; §6 (docs) → Task 6; §7 (failure handling) → Task 4 (failure messages) + Task 5 (harness asserts each failure branch).
- **Placeholder scan:** no "TBD", "TODO", "implement later", "fill in details". Every step has concrete code or commands. The placeholder warning in Task 5 Step 2 ("may show environment issues, fix in place") is intentional guidance for the implementer — it's not a missing detail in the plan, just an honest flag that shell-harness tests often need a small iteration to land.
- **Type consistency:** `AuthType`, `grantInvokeUrl`, `AccountPrincipal` all verified against `node_modules/aws-cdk-lib/aws-lambda/lib/function-url.d.ts:140` and `aws-iam/lib/principals.d.ts:292`. The `--aws-sigv4` flag and `aws configure export-credentials` command both match the existing `scripts/smoke.sh` usage. The retry-window constants (`RETRY_DELAY=5`, `RETRY_MAX_SECONDS=75`) appear once in Task 4 and are referenced identically in Task 5's harness expectations.
- **Acceptance criteria:** all ten items from design §9 trace to a task (see Task 7 Step 5).
