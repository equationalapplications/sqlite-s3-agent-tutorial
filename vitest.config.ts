import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20_000,
    // `infra/stack.ts` instantiates the stack at module load, so DISCORD_WEBHOOK_URL
    // must be in the environment before tests/infra.test.ts imports it. Setting it
    // in this globalSetup guarantees the env var exists for every test file.
    globalSetup: ['./tests/globalSetup.ts'],
  },
});
