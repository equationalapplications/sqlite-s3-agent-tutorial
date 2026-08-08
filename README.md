# sqlite-s3-agent-tutorial

A working example of the **SQLite-as-a-database-for-an-agent-on-AWS, rehydrated-by-S3**
pattern: a Discord bot that checks the weather and Bitcoin price once a day, asks an LLM
(Amazon Bedrock) to turn the raw value into a friendly message, posts it to a Discord
webhook, and remembers what it already posted — all state lives in a single SQLite file
in S3. No database server, no VPC.

## Quick start

```bash
npm install
npm test
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run local-fetch
```

That runs the writer against a local SQLite file with no AWS involved (Phase 1). To
deploy the real thing:

```bash
export AWS_PROFILE=your-profile
npm run deploy
npm run smoke
```

Before your first deploy, grant model access for `zai.glm-4.7-flash` in the Bedrock
console (`us-east-1` → Bedrock → Model access) — see [docs/02-rehydration.md](docs/02-rehydration.md#bedrock-setup)
for why this step exists and what breaks if you skip it.

## What's here

| Doc | Covers |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | The pattern, in prose: one Lambda, two ops, one bucket |
| [docs/02-rehydration.md](docs/02-rehydration.md) | Bootstrap, conditional writes, version-cached reads |
| [docs/03-schema.md](docs/03-schema.md) | Why three tables, not one |
| [docs/04-extending.md](docs/04-extending.md) | Adding a third source |
| [docs/05-from-tutorial-to-prod.md](docs/05-from-tutorial-to-prod.md) | What changes if you outgrow this |

## Cost

At one Discord post per day, `zai.glm-4.7-flash` costs under $0.02/year. See
[docs/bedrock-model-comparison.md](docs/bedrock-model-comparison.md) for alternatives.
