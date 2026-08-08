// tests/handler.test.ts
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHandler } from '../src/handler.js';

const s3 = mockClient(S3Client);
const bedrock = mockClient(BedrockRuntimeClient);

describe('runHandler', () => {
  let dir: string;

  beforeEach(() => {
    s3.reset();
    bedrock.reset();
    dir = mkdtempSync(join(tmpdir(), 'agent-handler-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes op="fetch" through the writer and returns 200', async () => {
    s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' }); // bootstrap
    s3.on(PutObjectCommand).resolves({ ETag: '"v1"' });
    bedrock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: 'Weather update: 72F' }] } },
      stopReason: 'end_turn',
    });

    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
      DB_PATH: join(dir, 'memory.db'),
      SOURCES: '["weather"]',
    };

    // Handler constructs its own SourceFetcher via the registry, which hits real
    // network — injected here via an override hook so the test stays hermetic.
    const result = await runHandler(
      { op: 'fetch' },
      env,
      { s3Client: s3 as unknown as S3Client, bedrockClient: bedrock as unknown as BedrockRuntimeClient },
      { weather: async () => '72F' },
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}');
    expect(body.outcome).toBe('success');
  });

  it('routes op="status" to a 501 stub (PR3 completes this op)', async () => {
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
      DB_PATH: join(dir, 'memory.db'),
    };

    const result = await runHandler({ op: 'status' }, env);
    expect(result.statusCode).toBe(501);
  });

  it('returns 400 for an unknown op', async () => {
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
    };

    const result = await runHandler({ op: 'bogus' }, env);
    expect(result.statusCode).toBe(400);
  });
});
