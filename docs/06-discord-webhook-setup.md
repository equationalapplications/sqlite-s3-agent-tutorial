# Discord webhook setup

This tutorial posts to a Discord channel via a **webhook** — a per-channel URL that
anyone with the URL can use to post messages into that channel. Each webhook is scoped
to one channel; the URL is the secret.

## Step 1: Create a Discord channel for the bot

If you don't already have a channel you'd like the bot to post to, create one in your
Discord server. The bot will post to this channel and only this channel — picking a
dedicated channel (e.g. `#weather-bot`) keeps its posts separate from general
discussion.

## Step 2: Open the channel's integrations settings

1. Open the Discord client (desktop or web) and navigate to the channel.
2. Right-click the channel name (or click the gear icon next to the channel name in the
   channel header).
3. Select **Edit Channel**.
4. In the left sidebar, click **Integrations**.

## Step 3: Create a webhook

1. Under **Webhooks**, click **New Webhook**.
2. Give the webhook a name (e.g. `Weather Bot`). The name appears as the "username" on
   posts the bot makes.
3. Optionally, set an avatar by uploading an image.
4. Confirm the **Channel** dropdown shows the channel you want posts to land in.
5. Click **Copy Webhook URL**. The URL has the form
   `https://discord.com/api/webhooks/<id>/<token>` — treat the entire URL as a secret.
   Anyone with the URL can post to the channel.

> **Permission required.** Creating, editing, or deleting a webhook needs the
> `MANAGE_WEBHOOKS` permission for the target channel. If the **New Webhook** button
> is greyed out or missing, you don't have that permission in the channel — contact a
> server administrator and ask them to either grant it or create the webhook on your
> behalf.

## Step 4: Configure the tutorial

Export the URL as the `DISCORD_WEBHOOK_URL` environment variable before running
locally. To keep the value out of shell history, source it from an untracked file
(`.env` is already in `.gitignore`):

```bash
# Local development — load from an untracked .env, then run:
set -a; . ./.env; set +a
npm run local-fetch
```

Where `.env` contains:

```bash
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/<id>/<token>'
```

When deploying via CDK, do the same — `infra/stack.ts` reads `DISCORD_WEBHOOK_URL`
at synth time (lines 55-63) and embeds it as a Lambda environment variable, so the
value should never appear on a command line that gets logged or shared:

```bash
# CI / local deploy — source from a secret store or masked CI variable, then deploy:
set -a; . ./.env.discord; set +a   # .env.discord is gitignored
npm run deploy
```

For production deployments, prefer **SSM Parameter Store** or **Secrets Manager**
over an inline Lambda environment value — `cdk.out/` and CloudFormation templates
echo environment values, and any operator with `logs:GetLogEvents` can read them
back from cold-start records. Never commit `.env`, `cdk.out/`, or logs that
contain the webhook URL.

The URL is the only credential the Lambda needs — its IAM role does not require any
Discord permissions.

## Step 5: Verify

Run `npm run local-fetch` once. Within a few seconds you should see a post in the
Discord channel. If you don't see one, check the CloudWatch logs (when deployed) or
the script's stdout (when running locally) — the `agent_runs.error` column captures
per-source failures including Discord post failures.

## Rotating the webhook

If the webhook URL is compromised (e.g. accidentally logged, pasted into a public
forum), the recovery is to delete the compromised webhook in the same **Integrations**
panel and create a new one. Update `DISCORD_WEBHOOK_URL` and redeploy.

Webhook executions remain subject to Discord's normal rate limits and can return
HTTP 429. The `fetch` op should honour the `Retry-After` response header (and the
`X-RateLimit-*` family) rather than retrying on a fixed cadence — Discord does not
publish the exact limits and they vary by channel and account.
