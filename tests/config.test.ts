// tests/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws when discordWebhookUrl is missing', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_WEBHOOK_URL/);
  });

  it('applies defaults for dbPath and sources', () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'my-bucket',
    });
    expect(config.dbPath).toBe('/tmp/memory.db');
    expect(config.sources).toEqual(['weather', 'crypto']);
    expect(config.discordWebhookUrl).toBe('https://discord.example/webhook');
  });

  it('parses a custom SOURCES env var', () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'my-bucket',
      SOURCES: '["weather"]',
    });
    expect(config.sources).toEqual(['weather']);
  });

  it('rejects a source outside the closed vocabulary', () => {
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        SOURCES: '["wether"]',
      }),
    ).toThrow(/wether/);
  });

  it('rejects malformed SOURCES JSON', () => {
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        SOURCES: 'not json',
      }),
    ).toThrow(/SOURCES/);
  });
});

describe('loadConfig — S3 and Bedrock fields', () => {
  const base = { DISCORD_WEBHOOK_URL: 'https://discord.example/webhook', SNAPSHOT_BUCKET: 'my-bucket' };

  it('throws when snapshotBucket is missing', () => {
    expect(() => loadConfig({ DISCORD_WEBHOOK_URL: base.DISCORD_WEBHOOK_URL })).toThrow(
      /SNAPSHOT_BUCKET/,
    );
  });

  it('applies defaults for region, snapshotKey, bedrock fields', () => {
    const config = loadConfig(base);
    expect(config.region).toBe('us-east-1');
    expect(config.snapshotBucket).toBe('my-bucket');
    expect(config.snapshotKey).toBe('memory.db');
    expect(config.bedrockModelId).toBe('zai.glm-4.7-flash');
    expect(config.bedrockRegion).toBe('us-east-1');
    expect(config.bedrockMaxOutputTokens).toBe(512);
    expect(config.reservedConcurrency).toBe(1);
  });

  it('resolves bedrockModelId against the family registry at load, failing on an unknown id', () => {
    expect(() => loadConfig({ ...base, BEDROCK_MODEL_ID: 'made-up.model-1' })).toThrow(
      /no known model family/,
    );
  });

  it('accepts an overridden bedrockModelId from a known family', () => {
    const config = loadConfig({ ...base, BEDROCK_MODEL_ID: 'amazon.nova-lite-v1:0' });
    expect(config.bedrockModelId).toBe('amazon.nova-lite-v1:0');
  });

  it('accepts a positive integer for BEDROCK_MAX_OUTPUT_TOKENS', () => {
    const config = loadConfig({ ...base, BEDROCK_MAX_OUTPUT_TOKENS: '1024' });
    expect(config.bedrockMaxOutputTokens).toBe(1024);
  });

  it('rejects zero for BEDROCK_MAX_OUTPUT_TOKENS', () => {
    expect(() => loadConfig({ ...base, BEDROCK_MAX_OUTPUT_TOKENS: '0' })).toThrow(
      /BEDROCK_MAX_OUTPUT_TOKENS.*positive integer/,
    );
  });

  it('rejects a negative value for BEDROCK_MAX_OUTPUT_TOKENS', () => {
    expect(() => loadConfig({ ...base, BEDROCK_MAX_OUTPUT_TOKENS: '-1' })).toThrow(
      /BEDROCK_MAX_OUTPUT_TOKENS.*positive integer/,
    );
  });

  it('rejects a fractional value for BEDROCK_MAX_OUTPUT_TOKENS', () => {
    expect(() => loadConfig({ ...base, BEDROCK_MAX_OUTPUT_TOKENS: '1.5' })).toThrow(
      /BEDROCK_MAX_OUTPUT_TOKENS.*positive integer/,
    );
  });

  it('rejects a negative value for RESERVED_CONCURRENCY', () => {
    expect(() => loadConfig({ ...base, RESERVED_CONCURRENCY: '-1' })).toThrow(
      /RESERVED_CONCURRENCY.*non-negative safe integer/,
    );
  });

  it('rejects a fractional value for RESERVED_CONCURRENCY', () => {
    expect(() => loadConfig({ ...base, RESERVED_CONCURRENCY: '1.5' })).toThrow(
      /RESERVED_CONCURRENCY.*non-negative safe integer/,
    );
  });

  it('defaults bedrockRegion to AWS_REGION when BEDROCK_REGION is unset', () => {
    // Without this, deploying with CDK_DEFAULT_REGION=eu-west-1 but leaving BEDROCK_REGION
    // unset would point the Bedrock client at us-east-1 while IAM grants the eu-west-1
    // resource ARN — first invoke hits AccessDeniedException. Tracking the runtime
    // region keeps client + IAM scope in agreement without two env vars to keep in lockstep.
    const config = loadConfig({ ...base, AWS_REGION: 'eu-west-1' });
    expect(config.region).toBe('eu-west-1');
    expect(config.bedrockRegion).toBe('eu-west-1');
  });
});
