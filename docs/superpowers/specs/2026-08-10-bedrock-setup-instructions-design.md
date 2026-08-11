# AWS Bedrock Setup Instructions — Design

**Date:** 2026-08-10
**Status:** Approved
**Scope:** Documentation-only change. Closes the gap between what the tutorial currently tells a reader about getting Bedrock working and what they actually need to know. No code changes.

---

## 1. Purpose and constraints

The tutorial currently documents Bedrock setup in a single 20-line section (`docs/02-rehydration.md` §Bedrock setup, lines 100–119) that lives at the bottom of a file whose title is "Rehydration." That placement was the original mistake this spec corrects: rehydration and AWS account setup are different topics and serve different readers at different moments.

The new doc is end-to-end setup — what a reader needs to know *before* `cdk deploy` produces a working bot. It is the only place in the repo that should describe Bedrock prerequisites. Everything in the current `02-rehydration.md` §Bedrock setup section moves into it, plus these currently-unstated prerequisites that a brand-new AWS account will trip on:

- **Bedrock may not be reachable in every account/region.** Verify Bedrock is accessible from the deploying account in `us-east-1` before attempting the procedure. Some account types (e.g. accounts that have only ever used Lightsail, or accounts in restricted Regions) do not have Bedrock in their service catalog. The doc's Step 1 covers the verification. Bedrock is also not a Free Tier service — the account needs a valid payment method, which is what "there's no pay-as-you-go option" actually looks like from the console.
- **The deploying CLI principal needs permission to create the stack.** A brand-new IAM user cannot run `cdk deploy` without a wide set of IAM/Lambda/S3/Events/ECR/CFN permissions, none of which is currently mentioned in the repo.
- **`cdk bootstrap` runs on the first deploy and needs its own permissions.** `scripts/deploy.sh:8–11` already invokes `npx cdk bootstrap` inside `npm run deploy`, so the reader never types the command — but nothing explains that the first `npm run deploy` therefore does two very different things, or that the extra CloudFormation/S3/ECR/SSM permissions bootstrap needs are a common first-run `AccessDenied`. The doc explains it rather than instructing a redundant manual step.
- **A container runtime must be running locally.** `infra/stack.ts:84` uses `lambda.DockerImageFunction` with `DockerImageCode.fromImageAsset`, so `cdk deploy` builds an image locally and pushes it to ECR. Without a running Docker (or Finch/Podman) daemon the deploy fails with a message that says nothing about Bedrock or this tutorial. Unmentioned anywhere in the repo today.
- **Titan Text Embeddings V2 is a second model the pipeline invokes.** `src/embed/titan.ts:16` pins `amazon.titan-embed-text-v2:0` and `infra/stack.ts:111` grants it; every tick calls it for RAG. A reader who arranges access only for the chat model gets an `AccessDeniedException` naming a model no doc ever told them about.

**Verification is CLI-first.** Each step carries an `aws` command that proves the step succeeded, so a reader can hand the bulk of the procedure to an AI assistant with CLI access rather than clicking through consoles. The AWS Marketplace subscription (Step 4) is the one genuine console-only detour and the doc says so explicitly. A pre-deploy `bedrock-runtime converse` probe collapses subscription, EULA, Region, and model-id mistakes into one sub-cent pass/fail *before* the reader spends a deploy cycle discovering them.

**Constraints that shape every decision below:**

- **Docs only.** No changes to `infra/stack.ts`, `src/`, or `tests/`. The runtime IAM policy CDK generates is correct; the gap is that the deployer's *own* IAM principal isn't documented as a prerequisite.
- **Match the existing `docs/06-discord-webhook-setup.md` style.** Same step-numbered walkthrough + tail reference pattern, same prose density, same code-fence conventions. The setup docs should look like a series, not a grab-bag.
- **Public tutorial quality.** Every non-obvious decision explained. Same bar the rest of the repo holds itself to.
- **Region pinned to `us-east-1` for the procedure.** Reference material addresses what changes if a reader moves.
- **No content duplication with `docs/bedrock-model-comparison.md` or `docs/07-budget-protection.md`.** The new doc points to both rather than restating their content.

---

## 2. Audience

**Primary.** A reader who has the tutorial repo, an AWS account they've just opened or rarely used, and no prior Bedrock experience. This is the unblock path — they should be able to complete a deploy top-to-bottom without asking a question.

**Secondary.** A reader who's already deployed this tutorial once and is now switching the default model (ZAI → Anthropic), switching regions, or troubleshooting a `cdk deploy` AccessDenied.

**What this doc is not.** It is not a Bedrock reference manual, not a model-comparison doc, and not a cost-optimization guide. Those are `docs/bedrock-model-comparison.md` and `docs/07-budget-protection.md`'s jobs; the new doc links to both.

---

## 3. New doc — `docs/11-aws-bedrock-setup.md`

### 3.1 Structure

Mirrors `docs/06-discord-webhook-setup.md`: numbered "Step N: …" sections for the procedure, then tail reference material under a clear divider. The *procedure* holds `06`'s prose density and stays around 150–200 lines; Reference carries the rest. Total target 300–400 lines, which makes this the longest setup doc in `docs/` — accepted deliberately, because the CLI verification blocks are what make the procedure runnable rather than readable.

Every step carries a CLI verification. The doc opens by telling the reader they can hand the procedure to an AI assistant with AWS CLI access, with a copy-pasteable framing prompt, and flags Step 4 as the one console-only detour.

```
# AWS Bedrock setup
  2–3 sentence opener: what this doc covers, why it lives separately
  from 02-rehydration.md.
  "Let your assistant drive it" note + copy-paste prompt block.
  Callout: Step 4 (Marketplace) is console-only; everything else
  is CLI-verifiable.

## Step 0: Local prerequisites
  - AWS CLI installed and authenticated:
      aws sts get-caller-identity
  - Node + npm install already done (README Quick start).
  - A running container runtime (Docker Desktop, Finch, Podman):
      docker info
    Why: infra/stack.ts:84 uses lambda.DockerImageFunction, so
    `cdk deploy` builds the image locally and pushes it to ECR.
    Without a daemon the deploy fails with a message that mentions
    neither Bedrock nor this tutorial.
  - Account has a valid payment method. Bedrock is not a Free Tier
    service; an account without one shows no pay-as-you-go option.

## Step 1: Confirm Bedrock is reachable in your account and region
  - Verify from the CLI rather than by hunting the console menu:
      aws bedrock list-foundation-models --region us-east-1 \
        --query "modelSummaries[?contains(modelId,'glm')].modelId"
  - A hit means Bedrock is reachable and the model exists in the
    Region. AccessDenied / unknown-service / empty list each mean
    something different — map each to its resolution.
  - If the service is unavailable in your account (some accounts
    that have only used Lightsail, or accounts in restricted
    Regions): the tutorial will not deploy. Stop here — typical
    resolutions are switching to a standard AWS account or to
    us-east-1.

## Step 2: Grant the deploying CLI principal permission to create the stack
  - Confirm which principal is deploying:
      aws sts get-caller-identity
  - Representative (NOT exhaustive) action list, so the reader can
    recognize the shape of what's needed: iam:CreateRole /
    AttachRolePolicy / PassRole; lambda:CreateFunction /
    UpdateFunctionCode; s3:CreateBucket / PutBucketPolicy /
    PutBucketTagging; events:CreateRule / PutTargets; ecr:
    CreateRepository / GetAuthorizationToken / InitiateLayerUpload /
    UploadLayerPart / CompleteLayerUpload / PutImage;
    cloudformation:CreateStack / UpdateStack / DeleteStack;
    sts:AssumeRole (CDK bootstrap deploy roles); ssm:GetParameter.
  - Framed as "representative" on purpose: an incomplete list
    presented as a minimum is worse than no list. The recommendation
    is AdministratorAccess for the first deploy, then scope down.
  - Explicit call-out: this is about the *deployer's* IAM principal,
    NOT the runtime Lambda role (which CDK generates automatically —
    see infra/stack.ts:103–113).

## Step 3: Understand what the first deploy bootstraps
  - You do NOT run cdk bootstrap by hand: scripts/deploy.sh:8–11
    already runs it inside `npm run deploy`. This step exists so
    the first run's extra activity and extra permission surface
    aren't a surprise.
  - What it does: provisions the CDKToolkit CloudFormation stack,
    an S3 staging bucket, an ECR repo, and the CDK deploy roles in
    the account the first time CDK is used in a Region.
  - Already done? (idempotent check):
      aws cloudformation describe-stacks --stack-name CDKToolkit \
        --region us-east-1
  - Why this matters: the first `npm run deploy` needs bootstrap-only
    permissions (CFN, S3, ECR, SSM, iam:CreateRole) on top of the
    stack's own, which is the most common first-run AccessDenied.

## Step 4: Subscribe to the model in AWS Marketplace  [console only]
  - Walk through the Marketplace subscription UI for
    zai.glm-4.7-flash.
  - Subscribing is free; you pay per token used through AWS billing.
  - Explicit disambiguation: zai.com (the vendor's own site, which
    has different plans with minimums) is *not* the right place.
    This tutorial uses the AWS Marketplace listing.
  - Say plainly that this is the one step an assistant cannot do
    for you, and why.

## Step 5: Confirm access to BOTH models this tutorial invokes
  - Two models, not one: the configured chat model
    (default zai.glm-4.7-flash) and the fixed embedding model
    amazon.titan-embed-text-v2:0 (src/embed/titan.ts:16), which
    every tick calls for RAG.
  - Verify each:
      aws bedrock get-foundation-model --region us-east-1 \
        --model-identifier zai.glm-4.7-flash
      aws bedrock get-foundation-model --region us-east-1 \
        --model-identifier amazon.titan-embed-text-v2:0
  - For zai.* models: nothing to click. The Marketplace subscription
    from Step 4 is the gate; Bedrock enables foundation-model access
    by default in commercial Regions once the subscription is in
    place.
  - For amazon.titan-*: Amazon-family access is enabled by default
    in most commercial-Region accounts, but not universally. If the
    probe fails, enable it on Bedrock → Model access.
  - For anthropic.claude-* models (only if switching the default):
    must accept the per-model EULA on that page before the first
    InvokeModel call succeeds.

## Step 6: Prove Bedrock works before you deploy
  - One real Converse call from the CLI, costing a fraction of a
    cent:
      aws bedrock-runtime converse --region us-east-1 \
        --model-id zai.glm-4.7-flash \
        --messages '[{"role":"user","content":[{"text":"hi"}]}]'
  - Why this step exists: it collapses Marketplace-subscription,
    EULA, Region, and model-id-format mistakes into a single
    pass/fail *before* the reader spends a bootstrap + deploy cycle
    discovering them. Each failure mode maps to a numbered step
    above; cross-reference Troubleshooting.
  - Optional second probe for the embedding model via
    bedrock-runtime invoke-model.

## Step 7: Deploy
  - Source .env.discord (set -a; . ./.env.discord; set +a).
  - If you plan to use the on-demand trigger (Step 9), set
    FETCH_TRIGGER_TOKEN NOW — it is read at synth time, so adding
    it later requires a redeploy.
  - npm run deploy.
  - What success looks like: stack outputs include the agent
    Function URL and the smoke status URL; no AccessDenied in
    CloudFormation events. If it fails:
      aws cloudformation describe-stack-events \
        --stack-name SqliteS3AgentTutorial --max-items 20

## Step 8: Verify with npm run smoke
  - Probes the status Function URL with SigV4 and asserts the URL
    actually requires it.
  - Does NOT invoke Bedrock; that's a separate check.
  - Read-only and safe to run any time.

## Step 9 (optional): Trigger a real fetch end-to-end
  - The on-demand trigger path, gated by FETCH_TRIGGER_TOKEN — which
    had to be set before Step 7's deploy. If you didn't, redeploy
    with it set.
  - Confirms the full pipeline: Lambda → S3 hydrate → external
    source fetch → Bedrock Converse + Titan embed → Discord post.
  - Points at README §"Triggering a fetch on demand" for the signed
    curl rather than restating it.

## Reference

  ### Region availability
    - The procedure assumes us-east-1. What changes if a reader
      moves: set AWS_REGION (scripts/deploy.sh:5 and the CDK env
      both read it) — the deployed Lambda's BEDROCK_REGION is
      hardcoded to the stack Region at infra/stack.ts:74, so it is
      NOT an independent knob for a deploy. BEDROCK_REGION only
      applies to local runs (src/config.ts:135). Some ZAI models are
      not available in every Region, and the Marketplace
      subscription is per-Region.

  ### Switching models
    - zai.glm-4.7-flash → anthropic.claude-*: requires EULA
      acceptance (Step 5). Resource ARN pattern changes too —
      bare id vs global.* prefix is decided per-family by
      src/format/families.ts. Don't hand-edit the id.
    - Point to docs/bedrock-model-comparison.md for picking a
      model; don't duplicate the comparison table here.

  ### Cost monitoring
    - Brief pointer to docs/07-budget-protection.md.
    - One-paragraph "what to expect at the default cadence":
      ~$0.02–$0.04/day at the 5-minute loop cadence from
      README.md §Cost.

  ### Troubleshooting
    A table: symptom → which step to revisit → the CLI command that
    confirms the diagnosis.
    - "Cannot connect to the Docker daemon" on cdk deploy → Step 0.
    - AccessDenied on cdk deploy → deployer IAM (Step 2);
      describe-stack-events shows the failing action.
    - AccessDeniedException naming the chat model → Marketplace
      subscription missing (Step 4) or Region mismatch.
    - AccessDeniedException naming amazon.titan-embed-text-v2:0 →
      Amazon-family model access (Step 5), a distinct failure from
      the chat model's.
    - ValidationException at first fetch → bad model id format
      (most often: hand-added a prefix that the family rejects).
    - ResourceNotFoundException → bare model id got a prefix by
      mistake (e.g. global.zai.glm-4.7-flash — zai.* family
      accepts only bare id per src/format/families.ts).
    - 403 on the on-demand trigger → FETCH_TRIGGER_TOKEN was not set
      before the deploy (Step 7), or the request isn't SigV4-signed.
```

### 3.2 What the new doc deliberately does NOT cover

- Model selection rationale or pricing comparison → `docs/bedrock-model-comparison.md`.
- Budget alarms, auto-revoke IAM, or detailed cost protection → `docs/07-budget-protection.md`.
- A least-privilege deployer IAM policy. The minimum-viable list is given; tightening it is the reader's job, not the tutorial's.
- VPC setup, custom domains, or any production hardening. The doc is for first-deploy, not prod.

---

## 4. Changes to existing files

Three small edits so the new doc slots in cleanly.

### 4.1 `docs/02-rehydration.md` — delete §Bedrock setup

Lines 100–119 (the `## Bedrock setup` heading and its body) are removed. The file returns to being a single-topic doc about the four rehydration mechanisms + the `/tmp` ceiling. No other edits to this file.

### 4.2 `README.md` — update one link and one table row

- **Lines 47–50:** currently link to `docs/02-rehydration.md#bedrock-setup`. Change to `docs/11-aws-bedrock-setup.md`. The phrasing stays — the warning that the deploy needs the Marketplace subscription before the first fetch is still true, just the link moves.
- **Line 186 docs table:** add a new row next to the existing `bedrock-model-comparison.md` entry:
  ```
  | [docs/11-aws-bedrock-setup.md](docs/11-aws-bedrock-setup.md) | Account type, deployer IAM, Marketplace subscription, Region, EULA, first-deploy smoke |
  ```

### 4.3 Cross-reference search

Before declaring done: search the entire repo for `02-rehydration.md#bedrock-setup` and any other inbound link to the deleted section. Update each to point to the new doc. The README is the only known caller; verify and surface any others.

### 4.4 `docs/09-lesson-script.md` — add new doc to the Prerequisite line

This is the RAG-extension lesson script. It assumes the student has already completed the base tutorial's Bedrock setup end-to-end, but currently names only `[08-rag-vector-search.md](08-rag-vector-search.md)` and `[01-architecture.md](01-architecture.md)` as prerequisites — neither of which is the canonical Bedrock-setup reference. Update line 5 to make the prereq explicit:

```
**Prerequisite:** the student has completed the base tutorial end-to-end,
including the Bedrock setup documented in
[11-aws-bedrock-setup.md](11-aws-bedrock-setup.md). The student has read
[08-rag-vector-search.md](08-rag-vector-search.md) and the base tutorial's
[01-architecture.md](01-architecture.md). Familiarity with the
writer/reader asymmetry in [01-architecture.md](01-architecture.md) and
the per-source error isolation in [03-schema.md](03-schema.md) is
assumed.
```

The wording changes from "has read" to "has completed … end-to-end" for the base tutorial, because by the time the student reaches the RAG lesson the base tutorial should be deployed and working — Bedrock setup is a setup step, not a reading step. `11-aws-bedrock-setup.md` is the pointer they can revisit if their base deploy is broken.

No other edits to `09-lesson-script.md`. The lesson bodies assume Bedrock is working but never reference the setup doc, so updating only the Prerequisite line is sufficient.

### 4.5 No-op list (explicitly)

The following are NOT changed by this spec:
- `infra/stack.ts` — runtime IAM is already correct.
- `src/format/families.ts` — model-id family resolution is already correct.
- Any source file under `src/`.
- Any test file under `tests/`.
- `docs/01-architecture.md`, `docs/03-schema.md`, `docs/04-extending.md`, `docs/05-from-tutorial-to-prod.md`, `docs/06-discord-webhook-setup.md`, `docs/07-budget-protection.md`, `docs/08-rag-vector-search.md`, `docs/10-concurrency.md`, `docs/bedrock-model-comparison.md`.
- `package.json`, `tsconfig*.json`, `vitest.config.ts`, `Dockerfile`.

---

## 5. Success criteria

### 5.1 Unblock test (primary audience)

A reader following the new doc top-to-bottom on a brand-new AWS account reaches a working first Discord post without asking a question and without consulting the now-deleted `02-rehydration.md` Bedrock section.

### 5.2 Quality test (secondary audience)

- All non-obvious decisions are explained, not just stated.
- The procedure section reads like `docs/06-discord-webhook-setup.md` and `docs/02-rehydration.md`: same prose density, same code-fence conventions, same heading depth, same tone. (Total length exceeds `06` because of the CLI blocks and the Reference tail; that is intended.)
- Every step except Step 4 has a CLI command that verifies it, and Step 4 is explicitly labelled console-only.
- Both invoked models are named — the configurable chat model and the fixed `amazon.titan-embed-text-v2:0` — and their failure modes are distinguished in Troubleshooting.
- Every `aws` command in the doc has been checked against the installed CLI's syntax (correct subcommand, flag names, and argument shapes) — no invented flags.
- The Marketplace subscription step is unambiguous about which site to subscribe on (AWS Marketplace, not zai.com).
- The EULA caveat is clearly conditional on the model family (Anthropic only), not presented as a blanket requirement.
- Every cross-link from and to the new doc resolves.

### 5.3 Integration test (the project itself)

- `docs/02-rehydration.md` is shorter by the deleted section and reads cleanly as a single-topic doc.
- `docs/09-lesson-script.md` Prerequisite line points to the new doc and reads cleanly as a single prerequisite statement.
- README's Quick start still makes sense end-to-end.
- No broken inbound links in live docs: `grep -rn '02-rehydration.md#bedrock-setup' README.md docs/*.md src infra` returns nothing. Scoped deliberately — `docs/superpowers/plans/` and `docs/superpowers/specs/` are historical records and are not rewritten.
- The new doc table row in the README links to a file that exists.

### 5.4 What we will NOT do

- No automated tests for doc content. Verification is the read-through checklist above plus the inbound-link grep.
- No live deploy against a real AWS account. The remote collaborator's actual attempt is the integration test.

---

## 6. Open items

None. The remote collaborator's three blockers — `.env` not being read, "no pay-as-you-go" confusion, and the unstated deployer-IAM prerequisite — are all addressed by this spec. The `.env` issue is a usage error rather than a docs gap (the README's `set -a; . ./.env; set +a` pattern is already documented at line 23), so it does not need a doc change. The Marketplace-vs-direct-vendor confusion is addressed by Step 4 of the new doc.
