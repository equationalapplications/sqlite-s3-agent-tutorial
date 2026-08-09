#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

# Both files are sensitive (the netrc holds AWS credentials, the fetch response holds the
# function output) and both live in a predictable location if hardcoded — `mktemp` gives a
# per-invocation path that an attacker on the same box can't pre-create or symlink-over.
# Exit trap cleans them up so a failure mid-run doesn't leave credentials on disk.
FETCH_RESPONSE_FILE=$(mktemp)
NETRC_FILE=$(mktemp)
chmod 600 "$NETRC_FILE"
# Populated below when the resolved credentials carry a SessionToken; kept off the
# process command line (visible in `ps aux` for the curl lifetime) by writing the
# header to a 0600 tempfile and letting curl read it via `--header "@file"`.
SECURITY_TOKEN_HEADER_FILE=""
trap 'rm -f "$FETCH_RESPONSE_FILE" "$NETRC_FILE" ${SECURITY_TOKEN_HEADER_FILE:+"$SECURITY_TOKEN_HEADER_FILE"}' EXIT

echo "=== Fetching stack outputs ==="
outputs=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output json)

FUNCTION_NAME=$(echo "$outputs" | jq -r '.[] | select(.OutputKey == "AgentFunctionName") | .OutputValue')
FUNCTION_URL=$(echo "$outputs" | jq -r '.[] | select(.OutputKey == "AgentFunctionUrl") | .OutputValue')

echo "Function:     $FUNCTION_NAME"
echo "Function URL: $FUNCTION_URL"

echo ""
echo "=== Invoking fetch ==="
aws lambda invoke \
  --profile "$PROFILE" \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --payload '{"op":"fetch"}' \
  --cli-binary-format raw-in-base64-out \
  "$FETCH_RESPONSE_FILE"

echo "Fetch response:"
cat "$FETCH_RESPONSE_FILE" | jq .

echo ""
echo "=== Waiting for the run to settle ==="
sleep 5

echo ""
echo "=== Querying status ==="
# Credentials go through a 0600 netrc file, not argv — `curl --user "$key:$secret"` would
# put the secret access key in `ps aux` output for the process lifetime.
#
# `aws configure export-credentials --format process` resolves through the full AWS CLI
# credential chain (env vars, SSO, `credential_process`, etc.), unlike `aws configure get`
# which only reads the static profile file. When the resolved credentials include a
# `SessionToken` — i.e. the profile is SSO or assumed-role — curl needs to send it as
# `X-Amz-Security-Token` for SigV4 to accept the signature.
FUNCTION_HOST=$(echo "$FUNCTION_URL" | sed -E 's#^https?://([^/]+).*#\1#')
credentials_json=$(aws configure export-credentials --profile "$PROFILE" --format process)
access_key=$(jq -r '.AccessKeyId' <<<"$credentials_json")
secret_key=$(jq -r '.SecretAccessKey' <<<"$credentials_json")
session_token=$(jq -r '.SessionToken // empty' <<<"$credentials_json")

printf 'machine %s login %s password %s\n' \
  "$FUNCTION_HOST" \
  "$access_key" \
  "$secret_key" \
  > "$NETRC_FILE"

curl_headers=(--header "Content-Type: application/json")
if [ -n "$session_token" ]; then
  SECURITY_TOKEN_HEADER_FILE=$(mktemp)
  chmod 600 "$SECURITY_TOKEN_HEADER_FILE"
  printf 'X-Amz-Security-Token: %s\n' "$session_token" \
    > "$SECURITY_TOKEN_HEADER_FILE"
  curl_headers+=(--header "@$SECURITY_TOKEN_HEADER_FILE")
fi

status_response=$(curl -s --aws-sigv4 "aws:amz:$REGION:lambda" \
  --netrc-file "$NETRC_FILE" \
  "${curl_headers[@]}" \
  --data '{"op":"status"}' \
  "$FUNCTION_URL")

printf '%s\n' "$status_response" | jq .

# printf '%s\n' passes the JSON through verbatim — echo can mangle backslash escapes and
# treat a leading '-' as a flag in some shells.
weather_present=$(printf '%s\n' "$status_response" | jq '.sources[] | select(.name == "weather") | .lastValue')
if [ -z "$weather_present" ] || [ "$weather_present" = "null" ]; then
  echo "FAIL: no weather source with a lastValue in status response" >&2
  exit 1
fi

echo ""
echo "=== Smoke test complete ==="
