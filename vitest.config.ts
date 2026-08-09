import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20_000,
    // `AgentStack`'s constructor reads DISCORD_WEBHOOK_URL (via loadConfig at synth
    // time), so the env var must be set before tests/infra.test.ts instantiates the
    // stack. Setting it in globalSetup guarantees it's present for every test file
    // without leaking the webhook URL into other test files' environments.
    globalSetup: ['./tests/globalSetup.ts'],
  },
});
