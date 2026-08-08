// tests/handler.test.ts
import {
  GetObjectCommand,
  HeadObjectCommand,
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

  it('routes op="status" through the reader and returns 200 with sources/recentNotifications', async () => {
    s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' });
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
    const clients = { s3Client: s3 as unknown as S3Client, bedrockClient: bedrock as unknown as BedrockRuntimeClient };

    // Publish a snapshot via fetch first, then read it via status. The S3 mock is
    // stateless across commands, so this test only checks the routing and response shape,
    // not that fetch's write is visible to a fresh S3 GET — status.test.ts already covers
    // the version-cache hydration logic against a real LocalStore.
    await runHandler({ op: 'fetch' }, env, clients, { weather: async () => '72F' });

    s3.on(HeadObjectCommand).rejects({ name: 'NotFound' });
    const result = await runHandler({ op: 'status' }, env, clients);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}');
    expect(body).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });
  });

  it('returns 400 for an unknown op', async () => {
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
    };

    const result = await runHandler({ op: 'bogus' }, env);
    expect(result.statusCode).toBe(400);
  });

  it('falls through to body parsing when event.op is not a string', async () => {
    // resolveOp must not pass a non-string event.op through as the resolved op —
    // a hostile Function URL client posting `{op: 42}` or `{op: {name: 'fetch'}}`
    // would otherwise undermine the typed string contract. Falling through to the
    // body (or to the 400 path) keeps behaviour predictable.
    s3.on(HeadObjectCommand).rejects({ name: 'NotFound' });
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
    };

    const result = await runHandler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { op: 42 as any, body: '{"op":"status"}' },
      env,
    );
    expect(result.statusCode).toBe(200); // status op (parsed from body)
    const body = JSON.parse(result.body ?? '{}');
    expect(body).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });
  });

  it('returns 400 when event.op is a non-string and the body is empty', async () => {
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runHandler({ op: 42 as any }, env);
    expect(result.statusCode).toBe(400);
  });

  it('parses op from event.body when called via a Function URL invocation', async () => {
    s3.on(HeadObjectCommand).rejects({ name: 'NotFound' });
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
    };

    // Lambda Function URLs deliver the HTTP request body as a string under `event.body`.
    const result = await runHandler({ body: '{"op":"status"}' }, env);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}');
    expect(body).toEqual({ snapshotVersion: null, sources: [], recentNotifications: [] });
  });

  it('returns 400 when the Function URL body is not valid JSON', async () => {
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
    };

    const result = await runHandler({ body: 'not json' }, env);
    expect(result.statusCode).toBe(400);
  });
});
