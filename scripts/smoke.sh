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
# a public-URL regression would still show the right status code.
UNSIGNED_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST \
  --header 'Content-Type: application/json' \
  --data '{"op":"status"}' \
  "$FUNCTION_URL")
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
  STATUS_CODE=$(curl -s -o "$STATUS_BODY_FILE" -w '%{http_code}' \
    --aws-sigv4 "aws:amz:$REGION:lambda" \
    --netrc-file "$NETRC_FILE" \
    "${CURL_HEADERS[@]}" \
    --data '{"op":"status"}' \
    "$FUNCTION_URL")
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
if ! jq -e . "$STATUS_BODY_FILE" >/dev/null 2>&1; then
  echo "FAIL: signed status response is not valid JSON" >&2
  cat "$STATUS_BODY_FILE" >&2
  exit 1
fi

# `has(field)` distinguishes a missing field from one whose value is `null`. The
# `// "fallback"` operator collapses both into the same string and would mask a
# real schema regression where the field goes missing — exactly the failure
# mode the schema check exists to catch.
SNAPSHOT_PRESENT=$(jq -r 'has("snapshotVersion")' "$STATUS_BODY_FILE")
SOURCES_PRESENT=$(jq -r 'has("sources")' "$STATUS_BODY_FILE")
RECENT_PRESENT=$(jq -r 'has("recentNotifications")' "$STATUS_BODY_FILE")

if [ "$SNAPSHOT_PRESENT" != "true" ] || [ "$SOURCES_PRESENT" != "true" ] || [ "$RECENT_PRESENT" != "true" ]; then
  echo "FAIL: signed status response is missing one or more required top-level fields (snapshotVersion, sources, recentNotifications)" >&2
  cat "$STATUS_BODY_FILE" >&2
  exit 1
fi

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
