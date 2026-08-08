#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

echo "=== Bootstrapping CDK (if needed) ==="
npx cdk bootstrap \
  --profile "$PROFILE" \
  "aws://$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)/$REGION"

echo "=== Building TypeScript ==="
npm run build

echo "=== Synthesising ==="
npx cdk synth --app "npx tsx infra/stack.ts" --profile "$PROFILE"

echo "=== Deploying ==="
npx cdk deploy --app "npx tsx infra/stack.ts" --profile "$PROFILE" --require-approval never

echo "=== Deployment complete ==="
aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output table
