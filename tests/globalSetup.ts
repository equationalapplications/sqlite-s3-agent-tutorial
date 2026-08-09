// tests/globalSetup.ts
// Sets DISCORD_WEBHOOK_URL before any test file runs, so `infra/stack.ts`'s
// module-load-time synth check (which throws if the env var is unset) is
// satisfied for `tests/infra.test.ts` without leaking the webhook URL into
// the rest of the test suite.
export default function setup(): void {
  if (process.env.DISCORD_WEBHOOK_URL === undefined || process.env.DISCORD_WEBHOOK_URL === '') {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/webhook';
  }
}
