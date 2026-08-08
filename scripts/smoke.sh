#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

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
  /tmp/fetch-response.json

echo "Fetch response:"
cat /tmp/fetch-response.json | jq .

echo ""
echo "=== Waiting for the run to settle ==="
sleep 5

echo ""
echo "=== Querying status ==="
# Credentials go through a 0600 netrc file, not argv — `curl --user "$key:$secret"` would
# put the secret access key in `ps aux` output for the process lifetime.
NETRC_FILE=$(mktemp)
chmod 600 "$NETRC_FILE"
trap 'rm -f "$NETRC_FILE"' EXIT
FUNCTION_HOST=$(echo "$FUNCTION_URL" | sed -E 's#^https?://([^/]+).*#\1#')
printf 'machine %s login %s password %s\n' \
  "$FUNCTION_HOST" \
  "$(aws configure get aws_access_key_id --profile "$PROFILE")" \
  "$(aws configure get aws_secret_access_key --profile "$PROFILE")" \
  > "$NETRC_FILE"

status_response=$(curl -s --aws-sigv4 "aws:amz:$REGION:lambda" \
  --netrc-file "$NETRC_FILE" \
  --header "Content-Type: application/json" \
  --data '{"op":"status"}' \
  "$FUNCTION_URL")

echo "$status_response" | jq .

weather_present=$(echo "$status_response" | jq '.sources[] | select(.name == "weather") | .lastValue')
if [ -z "$weather_present" ]; then
  echo "FAIL: no weather source with a lastValue in status response" >&2
  exit 1
fi

echo ""
echo "=== Smoke test complete ==="
