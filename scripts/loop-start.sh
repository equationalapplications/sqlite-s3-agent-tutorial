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
echo "=== Enabling loop rule ==="
aws events enable-rule \
  --name "$RULE_NAME" \
  --profile "$PROFILE" \
  --region "$REGION"

echo ""
echo "=== Confirming rule state ==="
STATE=$(aws events describe-rule \
  --name "$RULE_NAME" \
  --query State \
  --output text \
  --profile "$PROFILE" \
  --region "$REGION")

echo "Rule $RULE_NAME is now: $STATE"
