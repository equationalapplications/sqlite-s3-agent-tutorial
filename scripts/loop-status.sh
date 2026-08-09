#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

echo "=== Fetching loop rule name ==="
RULE_NAME=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='LoopRuleName'].OutputValue" \
  --output text)

if [ -z "$RULE_NAME" ] || [ "$RULE_NAME" = "None" ]; then
  echo "FAIL: stack $STACK_NAME has no LoopRuleName output — is the loop feature already deployed?" >&2
  exit 1
fi

echo "Rule: $RULE_NAME"

echo ""
echo "=== Reading loop rule state ==="
# Read-only — does not enable or disable the rule. Use this to check state before
# running loop-start/loop-stop, or after a redeploy that may have re-enabled the rule.
RULE_JSON=$(aws events describe-rule \
  --name "$RULE_NAME" \
  --profile "$PROFILE" \
  --region "$REGION")

STATE=$(echo "$RULE_JSON" | jq -r '.State // "UNKNOWN"')
SCHEDULE=$(echo "$RULE_JSON" | jq -r '.ScheduleExpression // "UNKNOWN"')
ARN=$(echo "$RULE_JSON" | jq -r '.Arn // "UNKNOWN"')

echo "State:   $STATE"
echo "Schedule: $SCHEDULE"
echo "ARN:     $ARN"

echo ""
case "$STATE" in
  ENABLED)
    echo "Loop is RUNNING — ticks fire every 5 minutes. Use 'npm run loop-stop' to pause."
    ;;
  DISABLED)
    echo "Loop is PAUSED — no ticks will fire. Use 'npm run loop-start' to resume."
    ;;
  *)
    echo "Unrecognized state — investigate before relying on this output." >&2
    exit 1
    ;;
esac
