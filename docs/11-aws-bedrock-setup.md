# AWS Bedrock setup

This is the AWS half of getting the tutorial running: everything a brand-new account
needs before `npm run deploy` produces a working bot. The Discord half is
[06-discord-webhook-setup.md](06-discord-webhook-setup.md). This used to live at the
bottom of [02-rehydration.md](02-rehydration.md), which was the wrong home — account
setup and rehydration are different topics, read at different moments.

Most AWS-side steps can be verified from the AWS CLI, which means you can hand
most of this to an AI assistant that has CLI access rather than clicking through
consoles. Step 0's local checks (`aws sts get-caller-identity`, `docker info`,
`npm test`) and the billing check in **Billing and Cost Management → Payment
preferences** are not AWS CLI checks — handle those yourself or read along. A
prompt that works:

```text
I'm setting up the sqlite-s3-agent-tutorial on a fresh AWS account. Walk me
through docs/11-aws-bedrock-setup.md using the AWS CLI in us-east-1: run each
step's verification command, tell me what the output means, and stop at the
first failure rather than continuing. Show me any command that creates,
subscribes to, or grants something before you run it. Do not run any IAM,
Marketplace, or write-API command without showing it to me first.
```

> **Step 4 is mostly the exception.** The AWS Marketplace listing is a console
> flow with a legal agreement, but the underlying Bedrock model agreement can
> also be created from the CLI (`aws bedrock create-foundation-model-agreement`)
> or accepted implicitly on the model's first invocation. The first-invocation
> path needs `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe`, and
> `aws-marketplace:ViewSubscriptions` on the invoking identity and can take up
> to 15 minutes to finalise; a click-through in the console has the same effect
> and is the route most readers should take. Expect to do this step yourself.

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

The tutorial's Lambda is a **container image** function (`infra/stack.ts:84-85` uses
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
| Empty output, command succeeds | Bedrock answered, but this model family isn't offered to your account/Region | See [bedrock-model-comparison.md](bedrock-model-comparison.md) and pick a model your account does list; the model must also be available in the Region you queried |
| `AccessDeniedException` | Your principal lacks `bedrock:ListFoundationModels` | Step 2 — this is an IAM problem, not a Bedrock one |
| `Could not connect to the endpoint URL` | Bedrock is not available in the Region you asked for | Your account lacks Bedrock in this Region (Lightsail-only, restricted Region, or SCP-blocked); see the note below |

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

```text
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

# Required only if this same principal performs Step 4's Marketplace subscribe
# or the first third-party model invocation (automatic subscription path):
aws-marketplace:Subscribe, aws-marketplace:Unsubscribe,
aws-marketplace:ViewSubscriptions
```

> **Treat that list as representative, not exhaustive.** CDK's exact call set shifts
> between versions, and an incomplete list presented as "the minimum" is worse than no
> list — it sends you hunting one denied action at a time. The pragmatic path is a
> short-lived deployer role for the first deploy (a fresh IAM user with
> `AdministratorAccess` works; rotate or delete it after the first successful deploy),
> then scoping down once you can see in CloudTrail what was actually called. If
> least-privilege scoping must wait, label the `AdministratorAccess` usage as a
> temporary exception rather than the steady state. Enumerating a least-privilege
> deploy policy is out of scope for this tutorial.

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

## Step 4: Subscribe to the model in AWS Marketplace

This is the console-only step, and it is the one people get wrong.

1. Open the [AWS Marketplace](https://aws.amazon.com/marketplace) console in the same
   account you authenticated in Step 0, and search for the model — `GLM-4.7-Flash` for
   this tutorial's default.
2. Open the listing and click **View purchase options** / **Subscribe**.
3. Accept the terms. **Subscribing costs nothing.** There is no minimum, no monthly
   fee, and no commitment — you pay per token consumed, billed through your normal AWS
   invoice alongside Lambda and S3.
4. Wait for the subscription status to show as active. It is usually immediate but can
   take a few minutes.

> **Subscribe on AWS Marketplace, not on the vendor's own site.** The model vendor
> (for the default model, `zai.com`) sells its own API plans, some with minimum spends.
> Those are a different product with different credentials, and they will not make
> `bedrock:InvokeModel` work. What this tutorial needs is the AWS Marketplace listing,
> reached from the AWS console, billed to your AWS account.

After subscribing in one Region, the same identity can request access to the model in
any other Region where that model is supported — the Marketplace subscription itself
is **not** per Region. What is per Region is *model availability*: re-running Step 1's
`list-foundation-models` in a new Region is the only way to confirm that a model exists
there before you move. Subscribing in `us-east-1` (this doc's pinned Region) is what
the rest of the steps assume.

> **CLI alternative for Step 4.** You can also create the Bedrock model agreement
> directly without visiting the Marketplace listing:
>
> ```bash
> aws bedrock list-foundation-model-agreement-offers \
>   --region us-east-1 --model-id zai.glm-4.7-flash
>
> aws bedrock create-foundation-model-agreement \
>   --region us-east-1 \
>   --model-id zai.glm-4.7-flash \
>   --offer-token "<token from the previous command>"
> ```
>
> Or rely on the implicit first-invocation subscription, which Bedrock performs in the
> background if the invoking identity carries the three `aws-marketplace:*` permissions
> from Step 2 — that path can take up to 15 minutes to finalise.

## Step 5: Confirm access to both models this tutorial invokes

There are two, and readers regularly arrange access for only the first:

| Model | Configurable? | Used for |
|---|---|---|
| `zai.glm-4.7-flash` (default) | Yes — `BEDROCK_MODEL_ID` (`src/config.ts:114`) | The friendly message + haiku, via Converse |
| `amazon.titan-embed-text-v2:0` | **No** — hardcoded at `src/embed/titan.ts:16` | Embedding each tick's message for RAG search |

Every tick calls both. `get-foundation-model` only returns metadata — to confirm your
account is actually authorised to invoke each model, use
`get-foundation-model-availability` and inspect `authorizationStatus`,
`agreementAvailability.status`, `entitlementAvailability`, and
`regionAvailability`:

```bash
# The chat model — Marketplace subscription from Step 4 is what gates this one.
aws bedrock get-foundation-model-availability --region us-east-1 \
  --model-id zai.glm-4.7-flash

# The embedding model — Amazon-family access, a separate gate.
aws bedrock get-foundation-model-availability --region us-east-1 \
  --model-id amazon.titan-embed-text-v2:0
```

For each model, every field must come back `AVAILABLE` / `AUTHORIZED`. What to do per
family if one doesn't:

- **`zai.*`** — nothing to click. The Marketplace subscription from Step 4 is the gate;
  Bedrock enables foundation-model access by default in commercial Regions once the
  subscription is in place, and the legacy manual *Bedrock → Model access* console flow
  is no longer the gating step for this model. A failure here means Step 4 didn't take,
  or took in a different Region.
- **`amazon.titan-*`** — Amazon-family models are enabled by default in most commercial
  Region accounts, but not universally. If `agreementAvailability.status` is
  `NOT_AVAILABLE`, open **Bedrock → Model access** in `us-east-1` and enable Titan Text
  Embeddings V2 there.
- **`anthropic.claude-*`** — only relevant if you switch the default. Anthropic models
  require a First Time Use submission (use-case description and a website URL) on the
  **Model access** page, or via the `PutUseCaseForModelAccess` API, before the first
  `InvokeModel` succeeds. That is a manual one-time action and is the one remaining
  reason to open that screen. It does **not** apply to the default model.

## Step 6: Prove Bedrock works before you deploy

One real model call, costing a fraction of a cent, tells you whether Steps 1, 4, and 5
actually landed:

```bash
# Should print the model's reply — a single token, e.g. `ok`.
aws bedrock-runtime converse \
  --region us-east-1 \
  --model-id zai.glm-4.7-flash \
  --messages '[{"role":"user","content":[{"text":"Reply with the single word: ok"}]}]' \
  --query "output.message.content[0].text" --output text
```

And the embedding model:

```bash
# Should write a JSON body containing a 256-float "embedding" array —
# matching the dimensions the deployed code requests (`src/embed/titan.ts:17`).
aws bedrock-runtime invoke-model \
  --region us-east-1 \
  --model-id amazon.titan-embed-text-v2:0 \
  --content-type application/json \
  --cli-binary-format raw-in-base64-out \
  --body '{"inputText":"hello","dimensions":256,"normalize":true}' \
  /tmp/titan-probe.json && head -c 80 /tmp/titan-probe.json && echo
```

**Why this step exists.** Without it, the first real Bedrock call happens inside a
deployed Lambda at Step 9, which means every subscription, EULA, Region, or model-id
mistake surfaces only at the next scheduled tick — up to five minutes of waiting, then a
CloudWatch log dive to read the actual error. The deploy itself succeeds either way; the
probe catches the same mistakes in two seconds with the error text on your own terminal.
Map what you get to [Troubleshooting](#troubleshooting) below before moving on — a failure
at this step will not fix itself during deployment.

> **Note on the model id.** Pass the **bare** id, exactly as above. Bedrock inference
> profile prefixes (`global.`, `us.`) are decided per model family by
> `src/format/families.ts` — the `zai.*` family accepts the bare id only, while
> `anthropic.claude-*` defaults to `global.`. The code adds the right prefix itself and
> throws at startup if you configure an id that already carries one. Never hand-edit a
> prefix onto `BEDROCK_MODEL_ID`.

## Step 7: Deploy

Three environment variables are read at **synth** time, which means they must be set
before `npm run deploy`, not after:

- `DISCORD_WEBHOOK_URL` — required. `infra/stack.ts` throws without it.
- `FETCH_TRIGGER_TOKEN` — optional, and only needed if you want the on-demand trigger
  in Step 9. **Set it now if you want it at all** — adding it later means another
  deploy.
- `BEDROCK_MODEL_ID` — optional. Leaving it unset keeps the default
  (`zai.glm-4.7-flash`, resolved at runtime by `src/config.ts:114`); setting it
  before deploy changes the model baked into the IAM policy the Lambda runs under,
  so a new value needs a redeploy to take effect.

```bash
export AWS_PROFILE=your-profile          # defaults to `default`
export AWS_REGION=us-east-1              # scripts/deploy.sh reads this

# Source secrets from an untracked file rather than echoing them inline.
set -a; . ./.env.discord; set +a         # .env.discord is gitignored
export FETCH_TRIGGER_TOKEN="$(openssl rand -hex 24)"   # optional — see Step 9

npm run deploy
```

`npm run deploy` bootstraps (Step 3), builds the TypeScript, builds and pushes the
container image, and deploys the `SqliteS3AgentTutorial` stack. Success looks like four
stack outputs:

```text
SqliteS3AgentTutorial.AgentFunctionName = ...
SqliteS3AgentTutorial.AgentFunctionUrl  = https://....lambda-url.us-east-1.on.aws/
SqliteS3AgentTutorial.LoopRuleName      = ...
SqliteS3AgentTutorial.SnapshotBucketName = ...
```

If it fails, the CloudFormation event log names the exact denied action or failed
resource:

```bash
aws cloudformation describe-stack-events \
  --stack-name SqliteS3AgentTutorial --region us-east-1 --max-items 20 \
  --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
  --output table
```

> **The schedule starts immediately.** The stack declares its EventBridge rule
> `enabled: true`, so the bot begins ticking every 5 minutes as soon as the deploy
> finishes. Run `npm run loop-stop` when you're done experimenting — see the README's
> Loop mode section and [07-budget-protection.md](07-budget-protection.md).

## Step 8: Verify the deployment

```bash
npm run smoke
```

This probes the status Function URL twice: once unsigned (expecting `403`, proving the
URL really does require IAM) and once SigV4-signed (expecting the status payload). It is
read-only and safe to run at any time, including mid-tick.

The Function URL is `AWS_IAM`-protected, so callers must SigV4-sign the request and
carry both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` permissions on the
caller's principal. An IAM denial at the Function URL boundary returns `403` *before*
`FETCH_TRIGGER_TOKEN` is even read; a `403` after IAM is authorised means the token is
missing or wrong, not that Bedrock is unreachable.

It deliberately does **not** call Bedrock, post to Discord, or write to S3 — so a
passing smoke run proves the deployment and its IAM are sound, and proves nothing at all
about your model access. Step 6 was that check; Step 9 is the end-to-end one.

## Step 9 (optional): Trigger a real fetch end-to-end

The scheduled run does this every 5 minutes on its own — but if you'd rather not wait,
and you set `FETCH_TRIGGER_TOKEN` before deploying in Step 7, you can trigger one over
HTTP. The request needs **both** a valid token and SigV4 signing with a same-account
principal; the full signed `curl` is in the README's *Triggering a fetch on demand*
section and is not repeated here.

A successful trigger exercises the entire pipeline: Lambda cold start → hydrate the
SQLite snapshot from S3 → fetch weather and crypto → Bedrock Converse for the message
and haiku → Titan embedding → conditional write back to S3 → Discord post. Within a few
seconds you should see a message in your Discord channel.

If you skipped `FETCH_TRIGGER_TOKEN` at deploy time, either wait up to 5 minutes for the
scheduled tick or redeploy with the variable set. If the trigger returns `403`, that is
the token or the signature — not Bedrock. Bedrock problems show up as a tick that runs
and posts nothing; check the Lambda's CloudWatch logs and match the exception against
[Troubleshooting](#troubleshooting).

---

## Reference

Everything above is the procedure. What follows is the material you come back for.

### Region availability

The procedure pins `us-east-1`. If you move:

- **Set `AWS_REGION`.** `scripts/deploy.sh:5` reads it, and it becomes the CDK stack's
  Region. That single variable is the whole change for a deploy.
- **`BEDROCK_REGION` is not a deploy knob.** `infra/stack.ts:74` hardcodes the deployed
  Lambda's `BEDROCK_REGION` to the stack's own Region, so setting it in your shell before
  a deploy does nothing. It only matters for local runs, where `src/config.ts:135` lets
  it override `AWS_REGION` — useful if you want to run the writer locally against a
  Bedrock Region different from the rest of your setup.
- **Model availability is per Region.** Not every model in
  [bedrock-model-comparison.md](bedrock-model-comparison.md) exists everywhere; re-run
  Step 1's `list-foundation-models` in the new Region before assuming.
- **The Marketplace subscription is per Region.** Moving Regions means subscribing again
  (Step 4). This catches people who move from `us-east-1` after a working deploy.
- **Bootstrap is per account *and* Region.** The first deploy into a new Region
  bootstraps again (Step 3).

### Switching models

`BEDROCK_MODEL_ID` selects the chat model at synth time (`infra/app.ts`,
`src/config.ts:114`). The embedding model is not configurable. To switch:

1. Confirm the new model is listed and subscribed in your Region — Steps 1, 4, and 5.
2. For `anthropic.claude-*`, submit the First Time Use form (intended use case and
   website URL) on **Bedrock → Model access** before the first invocation. This is the
   one family where a console step is still mandatory.
3. Set the **bare** base id and redeploy:

```bash
export BEDROCK_MODEL_ID=anthropic.claude-...    # bare id, no global./us. prefix
npm run deploy
```

The inference-profile prefix is supplied by the model's family in
`src/format/families.ts`, not by you: `zai.*` takes the bare id only, `amazon.nova-*`
accepts bare or `us.`, and `anthropic.claude-*` defaults to `global.`. Configuring an id
that already carries a prefix throws at startup by design, and the generated IAM policy
is derived from the same family resolution — so hand-editing a prefix breaks the policy
and the call together.

For which model to pick and what each costs, see
[bedrock-model-comparison.md](bedrock-model-comparison.md). That comparison is not
repeated here.

### Cost

Pricing on Bedrock changes; check the [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/)
before budgeting. As of the most recent AWS-published rates for `zai.glm-4.7-flash` in
`us-east-1` ($0.07 per 1M input tokens, $0.40 per 1M output tokens) and Titan Text
Embeddings V2 ($0.02 per 1M input tokens, no retries assumed), the worst case at the
default cadence is reproducible:

```text
calls/day           = 288                # 5-minute cadence
output_tokens/call  = 512                # BEDROCK_MAX_OUTPUT_TOKENS cap
output-only/day     = 288 × 512 × $0.40 / 1e6 ≈ $0.059
```

Add input tokens for the actual prompt size (typically a few hundred tokens) and the
Titan embedding per tick (a few hundred tokens) and the realistic number lands well
below $0.10/day. The $0.02–$0.04 range quoted in earlier revisions of this doc is a
measured typical case, not a budget ceiling — a leaked `FETCH_TRIGGER_TOKEN` lets an
authorised caller drive Bedrock calls as fast as they can sign requests, and the only
real cap is the budget alarm below. Lambda, S3, and EventBridge at this volume are
rounding errors next to Bedrock.

Set up a budget alert before leaving the loop running unattended:
[07-budget-protection.md](07-budget-protection.md) has the full breakdown and the
alarm setup.

### Troubleshooting

| Symptom | Cause | Go to |
|---|---|---|
| `Cannot connect to the Docker daemon` during `npm run deploy` | No container runtime running; the Lambda is a container image | Step 0 |
| `AccessDeniedException` on `list-foundation-models` | Deploying principal lacks Bedrock read permissions | Step 2 |
| `Could not connect to the endpoint URL` for a `bedrock` call | Bedrock not available in that Region | Step 1 |
| `AccessDenied` / `CREATE_FAILED` during `npm run deploy` | Deployer IAM, most often a bootstrap-only permission on the first run | Steps 2, 3 |
| `AccessDeniedException` naming the **chat** model | Marketplace subscription missing, or made in another Region | Steps 4, 1 |
| `AccessDeniedException` naming `amazon.titan-embed-text-v2:0` | Amazon-family model access not enabled — a *separate* gate from the chat model | Step 5 |
| `AccessDeniedException` on an `anthropic.claude-*` model | Per-model EULA not accepted | Step 5 |
| `ValidationException` on the first call | Malformed model id — usually a hand-added inference-profile prefix the family rejects | Step 6 note, `src/format/families.ts` |
| `ResourceNotFoundException` | A bare-id family got a prefix, e.g. `global.zai.glm-4.7-flash` | Step 6 note |
| Startup error: *"already carries the inference-profile prefix"* | `BEDROCK_MODEL_ID` was set to a prefixed id | Switching models, above |
| `403` from the on-demand trigger | `FETCH_TRIGGER_TOKEN` unset at deploy time, or the request isn't SigV4-signed | Steps 7, 9 |
| Deploy succeeds, ticks run, nothing posts to Discord | Bedrock or Discord failure inside the tick — `agent_runs.error` records it per source | CloudWatch logs, [06-discord-webhook-setup.md](06-discord-webhook-setup.md) |

The fastest general diagnostic is Step 6's `converse` probe. **It verifies the AWS CLI
principal only, not the deployed Lambda:** the Lambda uses its own execution role and
its own `BEDROCK_REGION` and `BEDROCK_MODEL_ID`, baked in at deploy time. If the probe
passes and the deployed bot still fails on a Bedrock call, check the Lambda's role
policy (`iam:PassRole` only attaches it; the role's own trust and inline policies are
what grant `bedrock:InvokeModel`), confirm the deployed `BEDROCK_REGION` in the
Lambda's environment matches a Region where the model is offered, and read the actual
CloudWatch error before assuming model access is fine.
