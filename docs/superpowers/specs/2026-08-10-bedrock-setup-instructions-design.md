# AWS Bedrock Setup Instructions — Design

**Date:** 2026-08-10
**Status:** Approved
**Scope:** Documentation-only change. Closes the gap between what the tutorial currently tells a reader about getting Bedrock working and what they actually need to know. No code changes.

---

## 1. Purpose and constraints

The tutorial currently documents Bedrock setup in a single 20-line section (`docs/02-rehydration.md` §Bedrock setup, lines 100–119) that lives at the bottom of a file whose title is "Rehydration." That placement was the original mistake this spec corrects: rehydration and AWS account setup are different topics and serve different readers at different moments.

The new doc is end-to-end setup — what a reader needs to know *before* `cdk deploy` produces a working bot. It is the only place in the repo that should describe Bedrock prerequisites. Everything in the current `02-rehydration.md` §Bedrock setup section moves into it, plus three currently-unstated prerequisites that a brand-new AWS account will trip on:

- **Bedrock may not be reachable in every account/region.** Verify Bedrock is accessible from the deploying account in `us-east-1` before attempting the procedure. Some account types (e.g. accounts that have only ever used Lightsail, or accounts in restricted Regions) do not have Bedrock in their service catalog. The doc's Step 1 covers the verification.
- **The deploying CLI principal needs permission to create the stack.** A brand-new IAM user cannot run `cdk deploy` without granting a wide set of IAM/Lambda/S3/Events/ECR/CFN permissions, none of which is currently mentioned in the repo.
- **`cdk bootstrap` is a first-time prerequisite.** Not currently mentioned anywhere in `README.md` or `docs/`.

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

Mirrors `docs/06-discord-webhook-setup.md`: numbered "Step N: …" sections for the procedure, then tail reference material. Target length 250–350 lines.

```
# AWS Bedrock setup
  2–3 sentence opener: what this doc covers, why it lives separately
  from 02-rehydration.md.

## Step 1: Confirm Bedrock is reachable in your account and region
  - Open the AWS console in us-east-1 and navigate to Bedrock.
  - If the service is unavailable in your account (some accounts
    that have only used Lightsail, or accounts in restricted
    Regions, may not see it): the tutorial will not deploy. Stop
    here and resolve before continuing — typical resolutions are
    switching to a standard AWS account or to us-east-1.
  - Standard accounts (including Free Tier) in commercial Regions
    (us-east-1 in particular): proceed.

## Step 2: Grant the deploying CLI principal permission to create the stack
  - Minimum IAM actions the principal needs:
      iam:CreateRole, iam:AttachRolePolicy, iam:PassRole
      lambda:CreateFunction, lambda:UpdateFunctionCode
      s3:CreateBucket, s3:PutBucketPolicy, s3:PutBucketTagging
      events:CreateRule, events:PutTargets
      ecr:CreateRepository, ecr:GetAuthorizationToken
      cloudformation:CreateStack / UpdateStack / DeleteStack + pass-role
      ssm:GetParameter (CDK bootstrap resources)
  - Honest trade-off note: AdministratorAccess for the first deploy,
    then scope down. A tighter policy is feasible but enumerating one
    is out of scope for this doc.
  - Explicit call-out: this is about the *deployer's* IAM principal,
    NOT the runtime Lambda role (which CDK generates automatically —
    see infra/stack.ts:103–107).

## Step 3: Run cdk bootstrap (first-time only)
  - What it does: provisions the CDKToolkit CloudFormation stack,
    an S3 staging bucket, and an ECR repo in the deploying account
    the first time CDK is used in a region.
  - The command: npx cdk bootstrap aws://<account-id>/us-east-1
  - Why this is unstated in the current README: it was an oversight.

## Step 4: Subscribe to the model in AWS Marketplace
  - Walk through the Marketplace subscription UI for
    zai.glm-4.7-flash.
  - Subscribing is free; you pay per token used through AWS billing.
  - Explicit disambiguation: zai.com (the vendor's own site, which
    has different plans with minimums) is *not* the right place.
    This tutorial uses the AWS Marketplace listing.

## Step 5: Confirm model access in the Bedrock console
  - Navigate to Bedrock → Model access in us-east-1.
  - For zai.* models: nothing to click. The Marketplace subscription
    from Step 4 is the gate; Bedrock enables foundation-model access
    by default in commercial Regions once the subscription is in
    place.
  - For anthropic.claude-* models: must accept the per-model EULA on
    this page before the first InvokeModel call succeeds. This is
    the one remaining reason to open the Model access screen for
    those families.

## Step 6: Deploy
  - Source .env.discord (set -a; . ./.env.discord; set +a).
  - npm run deploy.
  - What success looks like: stack outputs include the agent
    Function URL and the smoke status URL; no AccessDenied in
    CloudFormation events.

## Step 7: Verify with npm run smoke
  - Probes the status Function URL with SigV4 and asserts the URL
    actually requires it.
  - Does NOT invoke Bedrock; that's a separate check.
  - Read-only and safe to run any time.

## Step 8 (optional): Trigger a real fetch to invoke Bedrock
  - The on-demand trigger path, gated by FETCH_TRIGGER_TOKEN.
  - Confirms the full pipeline end-to-end: Lambda → S3 hydrate →
    external source fetch → Bedrock Converse call → Discord post.
  - The first Bedrock call here is where Marketplace-subscription
    mistakes (Step 4) and EULA mistakes (Step 5, for Anthropic)
    surface as AccessDeniedException.

## Reference

  ### Region availability
    - The procedure assumes us-east-1. What changes if a reader
      moves: AWS_REGION + BEDROCK_REGION env vars; some ZAI models
      are not available in every Region; Marketplace subscription
      is per-Region.

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
    - AccessDenied on cdk deploy → deployer IAM (Step 2).
    - AccessDeniedException at first fetch → Marketplace
      subscription missing (Step 4) or Region mismatch.
    - ValidationException at first fetch → bad model id format
      (most often: hand-added a prefix that the family rejects).
    - ResourceNotFoundException → bare model id got a prefix by
      mistake (e.g. global.zai.glm-4.7-flash — zai.* family
      accepts only bare id per src/format/families.ts).
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
- The doc reads like `docs/06-discord-webhook-setup.md` and `docs/02-rehydration.md`: same prose density, same code-fence conventions, same heading depth, same tone.
- The Marketplace subscription step is unambiguous about which site to subscribe on (AWS Marketplace, not zai.com).
- The EULA caveat is clearly conditional on the model family (Anthropic only), not presented as a blanket requirement.
- Every cross-link from and to the new doc resolves.

### 5.3 Integration test (the project itself)

- `docs/02-rehydration.md` is shorter by the deleted section and reads cleanly as a single-topic doc.
- `docs/09-lesson-script.md` Prerequisite line points to the new doc and reads cleanly as a single prerequisite statement.
- README's Quick start still makes sense end-to-end.
- No broken inbound links anywhere in the repo (`grep -r '02-rehydration.md#bedrock-setup' .` returns nothing).
- The new doc table row in the README links to a file that exists.

### 5.4 What we will NOT do

- No automated tests for doc content. Verification is the read-through checklist above plus the inbound-link grep.
- No live deploy against a real AWS account. The remote collaborator's actual attempt is the integration test.

---

## 6. Open items

None. The remote collaborator's three blockers — `.env` not being read, "no pay-as-you-go" confusion, and the unstated deployer-IAM prerequisite — are all addressed by this spec. The `.env` issue is a usage error rather than a docs gap (the README's `set -a; . ./.env; set +a` pattern is already documented at line 23), so it does not need a doc change. The Marketplace-vs-direct-vendor confusion is addressed by Step 4 of the new doc.
