# sqlite-s3-agent-tutorial

A working example of the **SQLite-as-a-database-for-an-agent-on-AWS, rehydrated-by-S3**
pattern: a Discord bot that checks the weather and Bitcoin price once a day, asks an LLM
(Amazon Bedrock) to turn the raw value into a friendly message, posts it to a Discord
webhook, and remembers what it already posted — all state lives in a single SQLite file
in S3. No database server, no VPC. The same file also doubles as a vector database: each
posted message gets embedded (Titan Text Embeddings V2) and searched with `sqlite-vec`,
so the bot can mention the closest past result — see
[docs/08-rag-vector-search.md](docs/08-rag-vector-search.md).

## Quick start

```bash
npm install
npm test

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
set -a; . ./.env.discord; set +a   # .env.discord is gitignored
npm run deploy
npm run smoke
```

Before your first deploy, ensure your AWS account in `us-east-1` has an active AWS
Marketplace subscription for `zai.glm-4.7-flash` (Bedrock enables foundation-model access
by default in commercial Regions once the Marketplace subscription is in place; the legacy
manual *Bedrock → Model access* console flow is no longer the gate for this model) — see
[docs/02-rehydration.md](docs/02-rehydration.md#bedrock-setup) for what else is required and
what breaks if you skip it.

## Triggering a fetch on demand

The daily `fetch` run is normally EventBridge's job, but you can also trigger one over
HTTP via the same Function URL the `status` op uses. This is off by default — set
`FETCH_TRIGGER_TOKEN` before deploying (`export FETCH_TRIGGER_TOKEN=...` before
`npm run deploy`, alongside `DISCORD_WEBHOOK_URL`), then:

```bash
curl -X POST "$FUNCTION_URL?token=$FETCH_TRIGGER_TOKEN" --data '{"op":"fetch"}'
```

Without a matching token, an HTTP-triggered `fetch` request is rejected with 403; the
scheduled EventBridge fetch is unaffected either way. Since anyone with a valid token can
run this repeatedly (a real Bedrock call and Discord post each time), see
[docs/07-budget-protection.md](docs/07-budget-protection.md) before relying on this in a
deploy you leave running unattended.

## What's here

| Doc | Covers |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | The pattern, in prose: one Lambda, two ops, one bucket |
| [docs/02-rehydration.md](docs/02-rehydration.md) | Bootstrap, conditional writes, version-cached reads |
| [docs/03-schema.md](docs/03-schema.md) | Why three tables, not one |
| [docs/04-extending.md](docs/04-extending.md) | Adding a third source |
| [docs/05-from-tutorial-to-prod.md](docs/05-from-tutorial-to-prod.md) | What changes if you outgrow this |
| [docs/07-budget-protection.md](docs/07-budget-protection.md) | Setting up an AWS Budget alert, and what could actually drive cost up |
| [docs/08-rag-vector-search.md](docs/08-rag-vector-search.md) | SQLite as a vector database too: sqlite-vec + Titan embeddings |

## Cost

At one Discord post per day, `zai.glm-4.7-flash` costs under $0.02/year. See
[docs/bedrock-model-comparison.md](docs/bedrock-model-comparison.md) for alternatives.
For a spending backstop against misconfiguration (e.g. a leaked on-demand fetch trigger
token — see the on-demand trigger below), see
[docs/07-budget-protection.md](docs/07-budget-protection.md).
