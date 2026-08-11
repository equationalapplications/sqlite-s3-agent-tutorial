# sqlite-s3-agent-tutorial

A working example of the **SQLite-as-a-database-for-an-agent-on-AWS, rehydrated-by-S3**
pattern: a Discord bot that checks the weather and Bitcoin price on a schedule, asks an LLM
(Amazon Bedrock) to turn the day's readings into a friendly message plus a closing haiku,
and posts it to a Discord webhook — all state lives in a single SQLite file in S3. No
database server, no VPC. The same file also doubles as a vector database: each tick's
message gets embedded (Titan Text Embeddings V2) and searched with `sqlite-vec`, so the
bot can mention the closest past result — see
[docs/08-rag-vector-search.md](docs/08-rag-vector-search.md). There is no dedup — every
tick posts, deliberately, to keep the tutorial's control flow simple; see
[docs/03-schema.md](docs/03-schema.md).

## Quick start

```bash
npm install
npm test
npm run typecheck

# Put your webhook URL in an untracked .env (see docs/06-discord-webhook-setup.md),
# then source it and run the writer — keeping the URL out of shell history.
set -a; . ./.env; set +a   # .env is gitignored
npm run local-fetch
```

That runs the writer against a local SQLite file with no AWS involved (Phase 1). To
get a Discord webhook URL, see
[docs/06-discord-webhook-setup.md](docs/06-discord-webhook-setup.md). To deploy the
real thing:

```bash
export AWS_PROFILE=your-profile
# Source the webhook URL from an untracked file rather than echoing it inline —
# `infra/stack.ts` reads DISCORD_WEBHOOK_URL at synth time and throws if it is unset.
# `.env.discord` is a separate file from the local-run `.env` above so a deploy never
# accidentally picks up other local-only vars (e.g. a test `DB_PATH` override) from
# the file meant for `npm run local-fetch`.
set -a; . ./.env.discord; set +a   # .env.discord is gitignored
npm run deploy
npm run smoke
```

`npm run smoke` is read-only and safe to run any time, including while a loop tick is in flight — it never invokes `fetch`, never posts to Discord, and never calls Bedrock. It probes the status Function URL with SigV4 and asserts the URL actually requires it.

Before your first deploy, ensure your AWS account in `us-east-1` has an active AWS
Marketplace subscription for `zai.glm-4.7-flash` (Bedrock enables foundation-model access
by default in commercial Regions once the Marketplace subscription is in place; the legacy
manual *Bedrock → Model access* console flow is no longer the gate for this model) — see
[docs/11-aws-bedrock-setup.md](docs/11-aws-bedrock-setup.md) for the full setup, what else
is required, and what breaks if you skip it.

## Loop mode

The deployed EventBridge schedule runs every 5 minutes by default. Use `loop-stop` to
pause the loop, and re-run `loop-start` only after `loop-stop` to resume it. Both
scripts toggle the EventBridge rule directly from your shell — no Lambda invocation,
no token, no extra IAM grants:

```bash
npm run loop-start   # calls `aws events enable-rule` on the deployed rule
npm run loop-stop    # calls `aws events disable-rule` — no further ticks
npm run loop-status  # reads `aws events describe-rule` — no side effects
```

While the loop is running, each tick posts one combined Discord message: a short
friendly comment drawn from today's date, weather, and crypto price, ending with a
haiku. If a past message in the corpus is close enough, the LLM's pre-suffix output
is mechanically appended with a `Reminds me of: <past message>` line. All three
scripts read the rule name from the `LoopRuleName` stack output and call the
EventBridge API directly using the same AWS CLI credentials the smoke script
already requires. `loop-status` is read-only — it prints the rule's current
`ENABLED`/`DISABLED` state plus its schedule expression and ARN.

**Stop the loop when you're done** — `loop-stop.sh` disables the EventBridge rule so
no further invocations occur and the recurring AWS cost stops. Note: running
`npm run deploy` after `loop-stop.sh` re-enables the rule, since the CDK stack
declares it `enabled: true` — run `npm run loop-status` after any redeploy to
confirm the state, then re-run `loop-stop.sh` if you want the loop to stay off. See
[docs/07-budget-protection.md](docs/07-budget-protection.md) for the per-day
Bedrock call rate at 5-min cadence.

To verify the reader side of the loop (no Discord post, no Bedrock call), run
`npm run smoke` — it checks the status endpoint and confirms it is SigV4-protected.

## Triggering a fetch on demand

The scheduled `fetch` run is normally EventBridge's job, but you can also trigger one over
HTTP via the same Function URL the `status` op uses. The Function URL is locked to
AWS_IAM — your CLI credentials must be authorized against the same-account URL grant
the stack synthesizes (smoke-status-iam design §3.1) before the request reaches the
handler, so the request must be SigV4-signed the same way `scripts/smoke.sh` signs its
status probe (a plain `curl` without `--aws-sigv4` gets `403` from the URL itself). This
is off by default — set `FETCH_TRIGGER_TOKEN` before deploying (`export
FETCH_TRIGGER_TOKEN=...` before `npm run deploy`, alongside `DISCORD_WEBHOOK_URL`), then
the token goes on the query string (`?token=...`) and `op` goes in the JSON body —
`resolveOp` in `src/handler.ts` only reads `op` from the top-level payload or the JSON
`body`, and the token check reads `queryStringParameters.token`, so putting the token in
the body or `op` on the query string will not work. Reusing the same `netrc` machinery
as the smoke script handles the access key / secret pair cleanly; `aws configure
export-credentials --format process` resolves SSO / session credentials too, and the
`X-Amz-Security-Token` header is added when the resolved credentials include a session
token:

```bash
FUNCTION_URL=$(aws cloudformation describe-stacks \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --stack-name SqliteS3AgentTutorial \
  --query "Stacks[0].Outputs[?OutputKey=='AgentFunctionUrl'].OutputValue" --output text)

# Build a 0600 netrc file from the resolved credential chain (env vars, SSO,
# credential_process, etc.). Unlike `aws configure get`, this handles every
# profile type the CLI supports.
NETRC=$(mktemp); chmod 600 "$NETRC"
FUNCTION_HOST=$(echo "$FUNCTION_URL" | sed -E 's#^https?://([^/]+).*#\1#')
CREDENTIALS=$(aws configure export-credentials --profile "$AWS_PROFILE" --format process)
printf 'machine %s login %s password %s\n' \
  "$FUNCTION_HOST" \
  "$(jq -r '.AccessKeyId' <<<"$CREDENTIALS")" \
  "$(jq -r '.SecretAccessKey' <<<"$CREDENTIALS")" > "$NETRC"

# Session token (SSO / assumed-role) is required by SigV4 when present.
SESSION_TOKEN=$(jq -r '.SessionToken // empty' <<<"$CREDENTIALS")
if [ -n "$SESSION_TOKEN" ]; then
  TOKEN_FILE=$(mktemp); chmod 600 "$TOKEN_FILE"
  printf 'X-Amz-Security-Token: %s\n' "$SESSION_TOKEN" > "$TOKEN_FILE"
  SESSION_HEADER=(--header @"$TOKEN_FILE")
fi

curl -X POST "$FUNCTION_URL?token=$FETCH_TRIGGER_TOKEN" \
  --aws-sigv4 "aws:amz:$AWS_REGION:lambda" \
  --netrc-file "$NETRC" \
  --header 'Content-Type: application/json' \
  "${SESSION_HEADER[@]}" \
  --data '{"op":"fetch"}'
```

Without a matching token *or* an authorized same-account IAM principal, an HTTP-triggered
`fetch` request is rejected with 403; the scheduled EventBridge fetch is unaffected either
way. Both checks are required — the token alone no longer suffices, and the IAM grant
alone without a token is treated the same as no token. Since an authorized caller with a
valid token can run this repeatedly (a real Bedrock call and Discord post each time), see
[docs/07-budget-protection.md](docs/07-budget-protection.md) before relying on this in a
deploy you leave running unattended.

## ⚠️ Concurrency

S3 has no partial file locking, so SQLite's own locking (`WAL` mode, `IMMEDIATE`
transactions) is blind to a second Lambda container holding its own copy in `/tmp`. What
keeps this safe is the conditional write: every publish carries one. When the snapshot
already exists, the put carries `If-Match: <the ETag we hydrated from>`; on the very
first write — no object yet — it carries `If-None-Match: "*"` instead, a conditional
create that fails if the key already exists. Either way, a writer whose base version has
moved gets a `412` instead of silently clobbering the winner. (Two related failures —
`404 NoSuchKey` and `409 Conditional Request Conflict` — are translated to the same
abort condition by `src/store/s3.ts`; the previous snapshot stays authoritative in all
three cases.) That is optimistic concurrency control applied to a whole database file —
the same pattern behind
[S3 conditional writes](https://simonwillison.net/2024/Nov/26/s3-conditional-writes/) and
[distributed SQLite on S3](https://dev.to/chris_king_bcff3b9663e84a/why-i-built-a-distributed-sqlite-on-s3-and-why-you-might-care-3h9h).

This tutorial treats a conditional-write failure as an abort rather than rebasing and
retrying: the tick's database work is discarded, but the Bedrock call and Discord post
it already made are not. On the fixed schedule with `reservedConcurrentExecutions: 1`
that never fires — it becomes reachable as soon as a second write path (a manual
trigger, say) can race the loop.

[docs/10-concurrency.md](docs/10-concurrency.md) covers the full topology, how to add
rebase-and-retry, the SQS single-writer queue for high contention, and why EFS is not the
multi-writer escape hatch it looks like.

## What's here

| Doc | Covers |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | The pattern, in prose: one Lambda, two ops, one bucket |
| [docs/02-rehydration.md](docs/02-rehydration.md) | Bootstrap, conditional writes, version-cached reads |
| [docs/03-schema.md](docs/03-schema.md) | The tables, and why there's no dedup |
| [docs/04-extending.md](docs/04-extending.md) | Adding a third source |
| [docs/05-from-tutorial-to-prod.md](docs/05-from-tutorial-to-prod.md) | What changes if you outgrow this |
| [docs/06-discord-webhook-setup.md](docs/06-discord-webhook-setup.md) | Creating and configuring the Discord webhook |
| [docs/07-budget-protection.md](docs/07-budget-protection.md) | Setting up an AWS Budget alert, and what could actually drive cost up |
| [docs/08-rag-vector-search.md](docs/08-rag-vector-search.md) | SQLite as a vector database too: sqlite-vec + Titan embeddings |
| [docs/09-lesson-script.md](docs/09-lesson-script.md) | A 10-lesson script for teaching the RAG extension (frame, check-in questions, expected reasoning) |
| [docs/10-concurrency.md](docs/10-concurrency.md) | Optimistic S3 rehydration, 412 handling, rebase-and-retry, the single-writer queue |
| [docs/11-aws-bedrock-setup.md](docs/11-aws-bedrock-setup.md) | Account type, deployer IAM, Marketplace subscription, Region, EULA, first-deploy smoke |
| [docs/12-composable-agents.md](docs/12-composable-agents.md) | The fetch tick as a lightweight composable agent, and the ladder up from it |
| [docs/bedrock-model-comparison.md](docs/bedrock-model-comparison.md) | Why `zai.glm-4.7-flash` is the default, and alternatives |

## Cost

At the default 5-minute loop cadence (288 ticks/day, 1 Converse + 1 Titan call per tick),
`zai.glm-4.7-flash` runs roughly $0.02–$0.04/day — see
[docs/07-budget-protection.md](docs/07-budget-protection.md) for the full breakdown and
what else can drive cost up (e.g. a leaked on-demand fetch trigger token — see the
on-demand trigger below). See [docs/bedrock-model-comparison.md](docs/bedrock-model-comparison.md)
for alternative models and their pricing.
