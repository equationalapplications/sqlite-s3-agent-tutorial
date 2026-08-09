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

## Step 4: Configure the tutorial

Set the URL as the `DISCORD_WEBHOOK_URL` environment variable when running locally:

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run local-fetch
```

When deploying via CDK, pass the URL at deploy time:

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run deploy
```

The URL is exposed to the Lambda as a regular environment variable. The Lambda's IAM
role does not need any Discord permissions — the webhook URL is the only credential.

## Step 5: Verify

Run `npm run local-fetch` once. Within a few seconds you should see a post in the
Discord channel. If you don't see one, check the CloudWatch logs (when deployed) or
the script's stdout (when running locally) — the `agent_runs.error` column captures
per-source failures including Discord post failures.

## Rotating the webhook

If the webhook URL is compromised (e.g. accidentally logged, pasted into a public
forum), the recovery is to delete the compromised webhook in the same **Integrations**
panel and create a new one. Update `DISCORD_WEBHOOK_URL` and redeploy. There is no
rate-limit concern with this — webhooks are a "delete-and-recreate" credential, not a
rotating key.
