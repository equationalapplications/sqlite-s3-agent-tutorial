# AWS Bedrock setup

This is the AWS half of getting the tutorial running: everything a brand-new account
needs before `npm run deploy` produces a working bot. The Discord half is
[06-discord-webhook-setup.md](06-discord-webhook-setup.md). This used to live at the
bottom of [02-rehydration.md](02-rehydration.md), which was the wrong home — account
setup and rehydration are different topics, read at different moments.

Every step below except Step 4 can be verified from the AWS CLI, which means you can
hand most of this to an AI assistant that has CLI access rather than clicking through
consoles. A prompt that works:

```
I'm setting up the sqlite-s3-agent-tutorial on a fresh AWS account. Walk me
through docs/11-aws-bedrock-setup.md using the AWS CLI in us-east-1: run each
step's verification command, tell me what the output means, and stop at the
first failure rather than continuing. Show me any command that creates,
subscribes to, or grants something before you run it.
```

> **Step 4 is the exception.** Subscribing to a model in AWS Marketplace has no
> CLI equivalent you can rely on — it is a console flow with a legal agreement.
> Expect to do that one yourself.

## Step 0: Local prerequisites

Four things must be true on your machine and account before anything else matters.

**1. The AWS CLI is installed and authenticated.**

```bash
# Should print your account id, user id, and principal ARN.
aws sts get-caller-identity
```

If this errors, install the AWS CLI and run `aws configure` (or `aws sso login`)
before continuing. Every other command in this doc assumes it works.

**2. A container runtime is running.**

```bash
# Should print server info, not "Cannot connect to the Docker daemon".
docker info
```

The tutorial's Lambda is a **container image** function (`infra/stack.ts:84` uses
`lambda.DockerImageFunction` with `DockerImageCode.fromImageAsset`), so `cdk deploy`
builds the image locally and pushes it to ECR. Without a running daemon the deploy
fails with a Docker error that mentions neither Bedrock nor this tutorial, which is a
confusing place to lose an hour. Docker Desktop, Finch, and Podman all work.

**3. Dependencies are installed.** `npm install` and `npm test` from the README's
Quick start should both pass. Nothing here depends on AWS yet.

**4. The account has a valid payment method.** Bedrock is not a Free Tier service.
An account without a payment method on file shows no pay-as-you-go option and will
refuse model subscriptions in Step 4 — if that is what you are seeing, this is why,
and it is fixed in **Billing and Cost Management → Payment preferences**, not in
Bedrock.

## Step 1: Confirm Bedrock is reachable in your account and Region

This whole tutorial pins `us-east-1`. Check that Bedrock answers there and that the
default model exists:

```bash
aws bedrock list-foundation-models --region us-east-1 \
  --query "modelSummaries[?contains(modelId, 'glm')].modelId" --output text
```

Read the result:

| Output | Meaning | What to do |
|---|---|---|
| One or more `zai.glm-…` ids | Bedrock is reachable and the model exists in the Region | Continue to Step 2 |
| Empty output, command succeeds | Bedrock answered, but this model family isn't offered to your account/Region | Try `--region us-east-1` explicitly; if still empty, see [bedrock-model-comparison.md](bedrock-model-comparison.md) and pick a model your account does list |
| `AccessDeniedException` | Your principal lacks `bedrock:ListFoundationModels` | Step 2 — this is an IAM problem, not a Bedrock one |
| `Could not connect to the endpoint URL` | Bedrock is not available in the Region you asked for | Use `us-east-1` |

Some account types — accounts that have only ever used Lightsail, accounts in
restricted Regions, some organisation-managed accounts with service control policies —
do not have Bedrock at all. If that is your account, stop here: the tutorial will not
deploy. The fix is a standard AWS account in a commercial Region, not a workaround.

## Step 2: Give the deploying principal permission to create the stack

This step is about **your** IAM principal — the identity `aws sts get-caller-identity`
printed in Step 0. It is *not* about the Lambda's runtime role, which CDK generates for
you (`infra/stack.ts:103-113` grants exactly the two Bedrock models the code invokes,
and nothing else). A brand-new IAM user typically has none of what a CDK deploy needs.

The deploy touches, at minimum:

```
iam:CreateRole, iam:AttachRolePolicy, iam:PassRole
lambda:CreateFunction, lambda:UpdateFunctionCode, lambda:CreateFunctionUrlConfig
s3:CreateBucket, s3:PutBucketPolicy, s3:PutBucketTagging
events:PutRule, events:PutTargets
ecr:CreateRepository, ecr:GetAuthorizationToken,
  ecr:InitiateLayerUpload, ecr:UploadLayerPart,
  ecr:CompleteLayerUpload, ecr:PutImage
cloudformation:CreateStack, cloudformation:UpdateStack, cloudformation:DeleteStack
sts:AssumeRole            (the CDK bootstrap deploy roles — see Step 3)
ssm:GetParameter          (CDK bootstrap version lookup)
```

> **Treat that list as representative, not exhaustive.** CDK's exact call set shifts
> between versions, and an incomplete list presented as "the minimum" is worse than no
> list — it sends you hunting one denied action at a time. The pragmatic path is
> `AdministratorAccess` on a dedicated deploy principal for the first deploy, then
> scoping down once you can see in CloudTrail what was actually called. Enumerating a
> least-privilege deploy policy is out of scope for this tutorial.

## Step 3: Know what the first deploy bootstraps

You do not run `cdk bootstrap` by hand — `scripts/deploy.sh:8-11` already runs it as
the first thing `npm run deploy` does. This step exists so that the first run's extra
activity isn't a surprise.

The first time CDK is used in an account/Region pair, it provisions a `CDKToolkit`
CloudFormation stack: an S3 staging bucket for assets, an ECR repository for container
images, an SSM parameter recording the bootstrap version, and a set of IAM roles CDK
assumes to do the deploy. Check whether that already happened:

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1 \
  --query "Stacks[0].StackStatus" --output text
```

`CREATE_COMPLETE` or `UPDATE_COMPLETE` means bootstrap is done and the first deploy
will skip straight to your stack. `ValidationError … does not exist` means the first
`npm run deploy` will bootstrap first — expect it to take a few extra minutes and to
need the CloudFormation, S3, ECR, SSM, and `iam:CreateRole` permissions from Step 2.
Most first-run `AccessDenied` failures land here rather than on the tutorial's own
resources.