# Budget protection

This tutorial's normal cost is near zero — see [the README's Cost section](../README.md#cost).
But four things can push it above "near zero" if misconfigured, and none of them are
caught by anything else in this repo: they're all *valid* requests that just happen more
often than intended.

## What can actually drive cost up

- **A leaked or brute-forced `FETCH_TRIGGER_TOKEN`.** The on-demand HTTP fetch trigger
  (`?op=fetch&token=...` on the Function URL — see the README's Quick start) runs a real
  Bedrock call and a real Discord post per request. Anyone with a valid token can invoke it
  as often as the Lambda's `reservedConcurrentExecutions: 1` allows — sequentially, but
  with no rate limit otherwise.
- **`RESERVED_CONCURRENCY` raised above 1, plus EventBridge retries re-enabled.**
  `infra/stack.ts` sets `retryAttempts: 0` on the schedule target deliberately (spec: a
  412 from a conditional write is informational, not transient — see
  [docs/01-architecture.md](01-architecture.md)). Someone hand-editing the CDK stack to
  "fix" what looks like a missed run could reintroduce retries, which replay Bedrock calls
  and Discord posts on every failure.
- **`SOURCES` or `BEDROCK_MAX_OUTPUT_TOKENS` misconfiguration.** More sources checked per
  run, or a much larger output token cap, both scale cost linearly and both are one
  environment variable away from the defaults.
- **Loop mode running unattended.** Switching the 5-minute loop on (`npm run loop-start`)
  drives ~576 Bedrock calls per day (1 Converse + 1 Titan per tick × 288 ticks/day) and
  grows both `agent_notifications` and `agent_embeddings` by ~576 rows each per day
  (~1,152 rows/day combined). At default model pricing this is roughly $0.02–$0.04/day,
  but a loop left running for a weekend amplifies the spend noticeably. `npm run
  loop-stop` disables the EventBridge rule so no further ticks fire — re-run it after
  any `npm run deploy` that re-enables the rule (see the redeploy caveat in the
  README's Loop mode section).

None of these are bugs this codebase can prevent by construction — they're operator
error, and the right backstop for operator error is a spending alarm, not more code.

## Set up an AWS Budget

A cost budget with an email (or SNS) alert takes a few minutes and catches all four cases
above, since all of them show up as spend regardless of which one caused it.

Console: **Billing and Cost Management → Budgets → Create budget → Cost budget**. Suggested
starting point for this tutorial:

- **Period:** Monthly.
- **Amount:** Something clearly above the tutorial's expected cost (the README's Cost
  section quotes under $0.02/year for the default model at one post/day) but low enough to
  catch a misconfiguration fast — $5/month is a reasonable tripwire.
- **Alert threshold:** 80% of budgeted amount, actual spend (not forecasted) — a same-day
  signal beats a forecast that takes a few days of history to become accurate.
- **Notification:** Your email, or an SNS topic if you want it to reach something other
  than email.

Equivalent CLI, if you'd rather script it than click through the console (replace
`ACCOUNT_ID` and the notification email):

```bash
aws budgets create-budget \
  --account-id ACCOUNT_ID \
  --budget '{
    "BudgetName": "sqlite-s3-agent-tutorial",
    "BudgetLimit": {"Amount": "5", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80
    },
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "you@example.com"}]
  }]'
```

## What this deliberately doesn't cover

Budgets **actions** (auto-revoking IAM permissions or stopping resources when a threshold
is breached) are a further step AWS Budgets supports, but they add their own IAM role and
failure modes to reason about — a notification you act on manually is enough backstop for
a tutorial-scale workload, and matches this repo's general preference for visibility over
automatic remediation (the same reasoning behind `agent_runs` being an observability log
rather than a self-healing mechanism — see [docs/03-schema.md](03-schema.md)). If you
outgrow that trade-off, [docs/05-from-tutorial-to-prod.md](05-from-tutorial-to-prod.md) is
the doc to extend.
