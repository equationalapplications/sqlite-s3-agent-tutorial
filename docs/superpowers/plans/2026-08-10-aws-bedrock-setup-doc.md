# AWS Bedrock Setup Doc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `docs/11-aws-bedrock-setup.md` — a CLI-first, end-to-end AWS setup walkthrough that gets a brand-new AWS account from zero to a working Discord post — and rewire the three existing docs that should point at it.

**Architecture:** Documentation only. The new doc mirrors `docs/06-discord-webhook-setup.md`'s numbered-step structure: Steps 0–9 as the procedure, then a `Reference` tail (Region, model switching, cost, troubleshooting). Every step carries an `aws` CLI command that proves it succeeded, so a reader can hand the work to an AI assistant with CLI access; Step 4 (AWS Marketplace subscription) is the one console-only detour and is labelled as such. Three existing files change: `docs/02-rehydration.md` loses its `## Bedrock setup` section, `README.md` gets a re-pointed link plus a docs-table row, and `docs/09-lesson-script.md` gets an updated Prerequisite line.

**Tech Stack:** Markdown. AWS CLI v2 (`bedrock`, `bedrock-runtime`, `cloudformation`, `sts`) for the commands quoted in the doc. No changes to `src/`, `infra/`, `tests/`, or any config file.

**Spec:** `docs/superpowers/specs/2026-08-10-bedrock-setup-instructions-design.md`

---

## Context the implementing engineer needs

You have not seen this repo. Read these before Task 1 — they are short:

- `docs/06-discord-webhook-setup.md` (99 lines) — **the style template.** Match it: sentence-case `## Step N: …` headings, prose wrapped at ~90 columns, `> **Bold callout.**` blockquotes for warnings, fenced `bash` blocks with a one-line `#` comment explaining the block's purpose.
- `docs/02-rehydration.md` lines 100–119 — the section being deleted. Its content is absorbed into the new doc's Steps 4–5.
- `README.md` lines 46–51 (the Bedrock warning), line 186 (docs table), lines 86–144 (the on-demand trigger section the new Step 9 links to).

Facts verified against the code — do not restate them differently:

| Fact | Source |
|---|---|
| The Lambda is a **container image** function, so `cdk deploy` needs a running Docker daemon | `infra/stack.ts:84` — `lambda.DockerImageFunction` / `DockerImageCode.fromImageAsset` |
| `npm run deploy` **already runs `cdk bootstrap`** — the reader never types it | `scripts/deploy.sh:8-11` |
| Stack name is `SqliteS3AgentTutorial` | `scripts/deploy.sh:6` |
| Deploy Region comes from `AWS_REGION` (default `us-east-1`), profile from `AWS_PROFILE` (default `default`) | `scripts/deploy.sh:4-5` |
| Stack outputs: `SnapshotBucketName`, `AgentFunctionName`, `AgentFunctionUrl`, `LoopRuleName` | `infra/stack.ts:152-155` |
| Two Bedrock models are invoked per tick: the configurable chat model and the **fixed** `amazon.titan-embed-text-v2:0` | `src/config.ts:114`, `src/embed/titan.ts:16`, `infra/stack.ts:103-113` |
| Default chat model is `zai.glm-4.7-flash` | `src/config.ts:114` |
| Deployed `BEDROCK_REGION` is hardcoded to the stack Region — not an independent knob | `infra/stack.ts:74`; the env var only matters locally, `src/config.ts:135` |
| `zai.*` accepts the **bare** model id only; `anthropic.claude-*` defaults to the `global.` prefix; a prefix on the configured id throws at startup | `src/format/families.ts` |
| `FETCH_TRIGGER_TOKEN` is read at **synth** time — setting it after deploying requires a redeploy | `README.md:94-95` |

CLI syntax was verified against aws-cli/2.36.11 while writing this plan. `bedrock-runtime converse` takes `--model-id` and `--messages` (a JSON document — shorthand is not supported). `bedrock get-foundation-model` takes `--model-identifier`, not `--model-id`. `bedrock-runtime invoke-model` takes `--body`, `--content-type`, `--model-id`, and a **positional outfile**, and needs `--cli-binary-format raw-in-base64-out` for a plain-JSON body on CLI v2.

---

## File Structure

- **Create** `docs/11-aws-bedrock-setup.md` — the only place in the repo describing Bedrock prerequisites. Built up over Tasks 1–4, one commit per section group, so each commit leaves a readable document.
- **Modify** `docs/02-rehydration.md` — delete lines 100–119 (`## Bedrock setup` + body). Task 5.
- **Modify** `README.md` — re-point the line-50 link, add a docs-table row. Task 6.
- **Modify** `docs/09-lesson-script.md` — rewrite line 5 (Prerequisite). Task 7.

Not touched (spec §4.5): `infra/`, `src/`, `tests/`, `package.json`, `tsconfig*.json`, `vitest.config.ts`, `Dockerfile`, and every other file in `docs/`. Historical records under `docs/superpowers/plans/` and `docs/superpowers/specs/` are **not** rewritten even though they contain stale links.

---

## Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the working branch**

```bash
git checkout -b docs/aws-bedrock-setup
git status --porcelain
```

Expected: branch created; the only modified file is the spec (already revised in the design session). If the spec shows as modified, commit it first:

```bash
git add docs/superpowers/specs/2026-08-10-bedrock-setup-instructions-design.md
git commit -m "docs(spec): CLI-first verification, Docker + Titan prerequisites"
```

---

## Task 1: New doc — opener and Steps 0–3

**Files:**
- Create: `docs/11-aws-bedrock-setup.md`

- [ ] **Step 1: Write the opener and Steps 0–3**

Create `docs/11-aws-bedrock-setup.md` with exactly this content:

````markdown
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
> then scope down once you can see in CloudTrail what was actually called. Label any
> `AdministratorAccess` usage as a temporary exception, not the steady state.
> Enumerating a least-privilege deploy policy is out of scope for this tutorial.

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
````

- [ ] **Step 2: Verify the file renders and no link is broken**

```bash
# Every relative link target must exist.
grep -o '](0[0-9]-[a-z0-9-]*\.md\|](bedrock-model-comparison\.md' docs/11-aws-bedrock-setup.md \
  | sed 's/](//' | sort -u | while read -r f; do
    test -f "docs/$f" && echo "OK   $f" || echo "MISS $f"
  done
```

Expected: `OK 06-discord-webhook-setup.md`, `OK 02-rehydration.md`, `OK bedrock-model-comparison.md`, `OK 07-budget-protection.md`. No `MISS` lines.

- [ ] **Step 3: Commit**

```bash
git add docs/11-aws-bedrock-setup.md
git commit -m "docs: add AWS Bedrock setup doc — prerequisites through bootstrap"
```

---

## Task 2: New doc — Steps 4–6 (Marketplace, model access, pre-deploy probe)

**Files:**
- Modify: `docs/11-aws-bedrock-setup.md` (append)

- [ ] **Step 1: Append Steps 4–6**

Append exactly this to the end of `docs/11-aws-bedrock-setup.md`:

````markdown
## Step 4: Subscribe to the model in AWS Marketplace

The Marketplace listing is a console flow, but the underlying Bedrock model agreement
can also be created from the CLI (`create-foundation-model-agreement`) or accepted
implicitly on the model's first invocation. The first-invocation path needs
`aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe`, and
`aws-marketplace:ViewSubscriptions` on the invoking identity and can take up to 15
minutes to finalise; a click-through in the console has the same effect. Most readers
should use the console flow:

1. Open the [AWS Marketplace](https://aws.amazon.com/marketplace) console in the same
   account you authenticated in Step 0, and search for the model — `GLM-4.7-Flash` for
   this tutorial's default.
2. Open the listing, review the current pricing and terms (free to subscribe; you pay
   only for tokens consumed), and click **View purchase options** / **Subscribe**.
3. Accept the terms. There is no minimum, no monthly fee, and no commitment — you pay
   per token consumed, billed through your normal AWS invoice alongside Lambda and S3.
4. Wait for the subscription status to show as active. It is usually immediate but can
   take a few minutes.

> **Subscribe on AWS Marketplace, not on the vendor's own site.** The model vendor
> (for the default model, `zai.com`) sells its own API plans, some with minimum spends.
> Those are a different product with different credentials, and they will not make
> `bedrock:InvokeModel` work. What this tutorial needs is the AWS Marketplace listing,
> reached from the AWS console, billed to your AWS account.

After subscribing in one Region, the same identity can request access to the model in
any other Region where that model is supported — the Marketplace subscription itself is
**not** per Region. What is per Region is *model availability*: re-running Step 1's
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
`agreementAvailability.status`, `entitlementAvailability`, and `regionAvailability`:

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
actually landed. The `converse` call hardcodes the default `zai.glm-4.7-flash` model;
if `BEDROCK_MODEL_ID` is set to anything else, run this probe against that id instead
— the converse command does **not** validate EULA or access for a non-default model.

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
mistake surfaces only at the next scheduled tick — up to five minutes of waiting, then
a CloudWatch log dive to read the actual error. The deploy itself succeeds either way;
the probe catches the same mistakes in two seconds with the error text on your own
terminal. Map what you get to [Troubleshooting](#troubleshooting) below before moving
on — a failure at this step will not fix itself during deployment. The converse probe
verifies the AWS CLI principal only, not the deployed Lambda; see Troubleshooting for
the Lambda-side checks when the probe passes but the deployed bot still fails.

> **Note on the model id.** Pass the **bare** id, exactly as above. Bedrock inference
> profile prefixes (`global.`, `us.`) are decided per model family by
> `src/format/families.ts` — the `zai.*` family accepts the bare id only, while
> `anthropic.claude-*` defaults to `global.`. The code adds the right prefix itself and
> throws at startup if you configure an id that already carries one. Never hand-edit a
> prefix onto `BEDROCK_MODEL_ID`.
````

- [ ] **Step 2: Verify the CLI syntax quoted in the doc is real**

These must all print usage without an "Unknown options" error. This validates flag
names only — it does not call AWS:

```bash
aws bedrock get-foundation-model --model-identifier zai.glm-4.7-flash --region us-east-1 --generate-cli-skeleton output >/dev/null && echo "get-foundation-model OK"
aws bedrock-runtime converse --model-id zai.glm-4.7-flash --messages '[{"role":"user","content":[{"text":"x"}]}]' --generate-cli-skeleton output >/dev/null && echo "converse OK"
aws bedrock-runtime invoke-model --model-id amazon.titan-embed-text-v2:0 --body '{"inputText":"x"}' --content-type application/json --cli-binary-format raw-in-base64-out --generate-cli-skeleton output >/dev/null && echo "invoke-model OK"
```

Expected: three `OK` lines. `--generate-cli-skeleton output` validates the inputs and
returns a sample response without sending a request, so this costs nothing.

- [ ] **Step 3: Commit**

```bash
git add docs/11-aws-bedrock-setup.md
git commit -m "docs: Bedrock setup — Marketplace, both model gates, pre-deploy probe"
```

---

## Task 3: New doc — Steps 7–9 (deploy, smoke, end-to-end)

**Files:**
- Modify: `docs/11-aws-bedrock-setup.md` (append)

- [ ] **Step 1: Append Steps 7–9**

Append exactly this:

````markdown
## Step 7: Deploy

Two environment variables are read at **synth** time, which means they must be set
before `npm run deploy`, not after:

- `DISCORD_WEBHOOK_URL` — required. `infra/stack.ts` throws without it.
- `FETCH_TRIGGER_TOKEN` — optional, and only needed if you want the on-demand trigger
  in Step 9. **Set it now if you want it at all** — adding it later means another
  deploy.

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

```
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
````

- [ ] **Step 2: Verify the referenced npm scripts and stack outputs are real**

```bash
grep -n '"deploy"\|"smoke"\|"loop-stop"' package.json
grep -n "CfnOutput" infra/stack.ts
```

Expected: `deploy`, `smoke`, and `loop-stop` all exist in `package.json`; the four
`CfnOutput` names in `infra/stack.ts:152-155` match the four quoted in Step 7.

- [ ] **Step 3: Commit**

```bash
git add docs/11-aws-bedrock-setup.md
git commit -m "docs: Bedrock setup — deploy, smoke verification, end-to-end trigger"
```

---

## Task 4: New doc — Reference tail

**Files:**
- Modify: `docs/11-aws-bedrock-setup.md` (append)

- [ ] **Step 1: Append the Reference section**

Append exactly this:

````markdown
---

# Reference

Everything above is the procedure. What follows is the material you come back for.

## Region availability

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

## Switching models

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

## Cost

Pricing on Bedrock changes; check the [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/)
before budgeting. As of the most recent AWS-published rates for `zai.glm-4.7-flash` in
`us-east-1` ($0.07 per 1M input tokens, $0.40 per 1M output tokens) and Titan Text
Embeddings V2 ($0.02 per 1M input tokens, no retries assumed), the worst case at the
default cadence is reproducible: 288 ticks/day × 512 output tokens × $0.40 / 1e6 ≈
$0.059/day for the Converse output alone, before input tokens and Titan embeddings.
The $0.02–$0.04 range quoted in earlier revisions of this doc is a measured typical
case, not a budget ceiling — a leaked `FETCH_TRIGGER_TOKEN` lets an authorised caller
drive Bedrock calls as fast as they can sign requests, and the only real cap is the
budget alarm below. Lambda, S3, and EventBridge at this volume are rounding errors next
to Bedrock.

Set up a budget alert before leaving the loop running unattended:
[07-budget-protection.md](07-budget-protection.md) has the full breakdown and the
alarm setup.

## Troubleshooting

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

The fastest general diagnostic is Step 6's `converse` probe. If it passes and the
deployed bot still fails, the problem is not model access.
````

- [ ] **Step 2: Verify anchors, links, and length**

```bash
wc -l docs/11-aws-bedrock-setup.md
grep -c '^## ' docs/11-aws-bedrock-setup.md
grep -n 'Troubleshooting' docs/11-aws-bedrock-setup.md
```

Expected: length in the 300–400 range (spec §3.1); the `#troubleshooting` anchor
referenced from Steps 6 and 9 matches the `## Troubleshooting` heading in Reference.

- [ ] **Step 3: Read the whole doc top to bottom**

Read `docs/11-aws-bedrock-setup.md` in full against `docs/06-discord-webhook-setup.md`
and confirm: sentence-case headings, ~90-column prose, no step that says "configure
appropriately" without showing the command, and every `aws` invocation carries
`--region us-east-1` or an explanation of why it doesn't.

- [ ] **Step 4: Commit**

```bash
git add docs/11-aws-bedrock-setup.md
git commit -m "docs: Bedrock setup reference — Region, model switching, cost, troubleshooting"
```

---

## Task 5: Delete the Bedrock section from 02-rehydration.md

**Files:**
- Modify: `docs/02-rehydration.md:100-119`

- [ ] **Step 1: Confirm the exact boundaries before deleting**

```bash
sed -n '96,119p' docs/02-rehydration.md
```

Expected: line 100 is `## Bedrock setup`, lines 102–117 are its two paragraphs, and
line 119 is the trailing `For Discord webhook setup, see …` pointer. Line 98 ends the
preceding `/tmp`-ceiling paragraph.

- [ ] **Step 2: Delete lines 100–119**

Remove the `## Bedrock setup` heading, both paragraphs, **and** the trailing Discord
pointer line — the file's remaining content is entirely about rehydration, and a lone
Discord link at the end of it is a leftover from the section being removed. The file
should now end with the ephemeral-storage paragraph that currently ends at line 98.

Verify:

```bash
tail -5 docs/02-rehydration.md
grep -c 'Bedrock' docs/02-rehydration.md
```

Expected: the file ends on the `agent_runs` / RAG-corpus sentence; `grep -c` returns
`0`. Trailing blank lines: exactly one newline at end of file, no blank line before it.

- [ ] **Step 3: Commit**

```bash
git add docs/02-rehydration.md
git commit -m "docs(rehydration): move Bedrock setup out to 11-aws-bedrock-setup.md"
```

---

## Task 6: Re-point README

**Files:**
- Modify: `README.md:46-51`, `README.md:186`

- [ ] **Step 1: Re-point the pre-deploy warning**

Replace `README.md` lines 46–51 with:

```markdown
Before your first deploy, ensure your AWS account in `us-east-1` has an active AWS
Marketplace subscription for `zai.glm-4.7-flash` (Bedrock enables foundation-model access
by default in commercial Regions once the Marketplace subscription is in place; the legacy
manual *Bedrock → Model access* console flow is no longer the gate for this model) — see
[docs/11-aws-bedrock-setup.md](docs/11-aws-bedrock-setup.md) for the full setup, what else
is required, and what breaks if you skip it.
```

The only substantive change is the link target and the tail phrasing; the Marketplace
warning itself is still accurate and stays.

- [ ] **Step 2: Add the docs-table row**

In the `## What's here` table, insert this row immediately **before** the
`bedrock-model-comparison.md` row (so numbered docs stay in order and the two Bedrock
docs sit adjacent):

```markdown
| [docs/11-aws-bedrock-setup.md](docs/11-aws-bedrock-setup.md) | Account type, deployer IAM, Marketplace subscription, Region, EULA, first-deploy smoke |
```

- [ ] **Step 3: Verify**

```bash
grep -n '02-rehydration.md#bedrock-setup' README.md || echo "no stale anchor — good"
grep -n '11-aws-bedrock-setup' README.md
test -f docs/11-aws-bedrock-setup.md && echo "target exists"
```

Expected: no stale anchor; two `11-aws-bedrock-setup` hits (the warning and the table
row); target exists.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): point Bedrock setup at 11-aws-bedrock-setup.md"
```

---

## Task 7: Update the lesson-script prerequisite

**Files:**
- Modify: `docs/09-lesson-script.md:5`

- [ ] **Step 1: Replace line 5**

Current line 5 reads:

```markdown
**Prerequisite:** the student has read [08-rag-vector-search.md](08-rag-vector-search.md) and the base tutorial's [01-architecture.md](01-architecture.md). Familiarity with the writer/reader asymmetry in [01-architecture.md](01-architecture.md) and the per-source error isolation in [03-schema.md](03-schema.md) is assumed.
```

Replace it with (single line — the file's other prose is unwrapped, match that):

```markdown
**Prerequisite:** the student has completed the base tutorial end-to-end, including the AWS setup in [11-aws-bedrock-setup.md](11-aws-bedrock-setup.md) — the RAG lesson assumes a deployed, working bot, and that doc is where to go if the base deploy is broken. The student has read [08-rag-vector-search.md](08-rag-vector-search.md) and the base tutorial's [01-architecture.md](01-architecture.md). Familiarity with the writer/reader asymmetry in [01-architecture.md](01-architecture.md) and the per-source error isolation in [03-schema.md](03-schema.md) is assumed.
```

"has read" becomes "has completed … end-to-end" for the base tutorial because by this
point the student needs a *deployed* system, not just a read one — Titan embeddings are
being invoked live throughout the lesson.

- [ ] **Step 2: Verify no other edits to the file**

```bash
git diff --stat docs/09-lesson-script.md
```

Expected: `1 file changed, 1 insertion(+), 1 deletion(-)`.

- [ ] **Step 3: Commit**

```bash
git add docs/09-lesson-script.md
git commit -m "docs(lesson-script): require completed base tutorial incl. Bedrock setup"
```

---

## Task 8: Final verification

**Files:** none modified

- [ ] **Step 1: No stale inbound links in live docs**

```bash
grep -rn '02-rehydration.md#bedrock-setup' README.md docs/*.md src infra scripts 2>/dev/null \
  || echo "clean"
```

Expected: `clean`. Scoped deliberately — `docs/superpowers/plans/` and
`docs/superpowers/specs/` are historical records and are **not** rewritten, so a repo-wide
grep will still show hits there. That is correct.

- [ ] **Step 2: Every relative markdown link in the touched files resolves**

```bash
for f in README.md docs/02-rehydration.md docs/09-lesson-script.md docs/11-aws-bedrock-setup.md; do
  d=$(dirname "$f")
  grep -o '](\([^)#h][^)]*\.md\)' "$f" | sed 's/](//' | sort -u | while read -r t; do
    test -f "$d/$t" || echo "BROKEN in $f -> $t"
  done
done
echo "link check done"
```

Expected: no `BROKEN` lines.

- [ ] **Step 3: Repo still green**

```bash
npm test && npm run typecheck
```

Expected: both pass. Nothing outside `docs/` and `README.md` changed, so this is a
regression guard, not a real risk.

- [ ] **Step 4: Read-through against the spec's success criteria**

Confirm each of spec §5.2 by reading `docs/11-aws-bedrock-setup.md`:

- Procedure prose density matches `06-discord-webhook-setup.md`.
- Every step except Step 4 carries a CLI verification; Step 4 is explicitly labelled
  console-only.
- Both invoked models are named, and their `AccessDeniedException` cases are
  distinguished in Troubleshooting.
- The Marketplace-vs-vendor-site disambiguation is unambiguous.
- The Anthropic EULA is conditional on the family, never blanket.
- No content duplicated from `bedrock-model-comparison.md` or `07-budget-protection.md`
  beyond a one-line pointer plus the headline cost figure.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin docs/aws-bedrock-setup
gh pr create --title "docs: AWS Bedrock setup walkthrough for new AWS accounts" --body "$(cat <<'EOF'
Adds `docs/11-aws-bedrock-setup.md` — CLI-first, end-to-end AWS setup for a brand-new
account, from local prerequisites through a verified end-to-end Discord post.

Closes the gaps the remote collaborator hit: the deployer's own IAM principal, the
Marketplace-vs-vendor-site confusion, the missing container-runtime prerequisite (the
Lambda is a `DockerImageFunction`), and the second Bedrock model
(`amazon.titan-embed-text-v2:0`) that no doc previously named.

Also moves the old `02-rehydration.md` §Bedrock setup section into it, re-points the
README, and updates the lesson-script prerequisite.

Docs only — no changes under `src/`, `infra/`, or `tests/`.

Spec: `docs/superpowers/specs/2026-08-10-bedrock-setup-instructions-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

Spec coverage check, section by section:

| Spec section | Task |
|---|---|
| §1 Bedrock reachability | Task 1, Step 1 |
| §1 payment method / "no pay-as-you-go" | Task 1, Step 0 item 4 |
| §1 deployer IAM | Task 1, Step 2 |
| §1 bootstrap | Task 1, Step 3 |
| §1 container runtime | Task 1, Step 0 item 2 |
| §1 Titan second model | Task 2, Step 5 |
| §1 CLI-first verification | every step; assistant prompt block in Task 1 |
| §3.1 Steps 0–9 | Tasks 1–3 |
| §3.1 Reference (Region, switching, cost, troubleshooting) | Task 4 |
| §4.1 delete 02-rehydration §Bedrock setup | Task 5 |
| §4.2 README link + table row | Task 6 |
| §4.3 cross-reference search | Task 8, Steps 1–2 |
| §4.4 09-lesson-script prerequisite | Task 7 |
| §5.2 quality criteria | Task 8, Step 4 |
| §5.3 integration criteria | Task 8, Steps 1–3 |

One deliberate divergence from the spec, decided while writing this plan: spec §3.1's
Step 3 was written as "run `cdk bootstrap` (first-time only)" with a command for the
reader to type. `scripts/deploy.sh:8-11` already runs it inside `npm run deploy`, so
instructing a manual run would be redundant and would imply the deploy doesn't handle it.
The step is reframed as "know what the first deploy bootstraps," keeping the idempotent
`describe-stacks` check and the permission-surface explanation, which are the parts that
carry real information. The spec has been updated to match.
