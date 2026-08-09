// tests/handler.test.ts
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Uint8ArrayBlobAdapter } from '@smithy/core/serde';
import { mockClient } from 'aws-sdk-client-mock';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHandler } from '../src/handler.js';

const s3 = mockClient(S3Client);
const bedrock = mockClient(BedrockRuntimeClient);

describe('runHandler', () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    s3.reset();
    bedrock.reset();
    dir = mkdtempSync(join(tmpdir(), 'agent-handler-test-'));
    // Stub the Titan embed call (`InvokeModelCommand`) globally so the embedder gets
    // a valid 256-dim vector. Without this, runFetch catches the embed failure and
    // still returns success — a regression in the Titan path could pass through.
    // The body must be a smithy `IUint8ArrayBlobAdapter` (a Uint8Array with a
    // `transformToString` method); using a plain Uint8Array trips the SDK's strict
    // input type. `Uint8ArrayBlobAdapter.fromString` produces a properly adapted one.
    bedrock.on(InvokeModelCommand).resolves({
      body: Uint8ArrayBlobAdapter.fromString(JSON.stringify({ embedding: new Array(256).fill(0) })),
    });
    // Stub the real fetch the DiscordPoster uses. Without this, the writer can perform
    // an unstubbed outbound POST and still return 200 after runFetch catches the failure
    // — which would let a regression in the embed or format path hide behind the
    // swallowing catch. A 204 No Content is a valid Discord webhook success.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    fetchSpy.mockRestore();
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

  it('routes op="status" through the reader and returns 200 with the empty-state shape when no snapshot exists', async () => {
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

  describe('fetch-trigger token gating', () => {
    const baseEnv = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SNAPSHOT_BUCKET: 'test-bucket',
      SOURCES: '["weather"]',
    };

    it('rejects an HTTP-triggered fetch with 403 when FETCH_TRIGGER_TOKEN is unset', async () => {
      const env = { ...baseEnv, DB_PATH: join(dir, 'memory.db') };
      const result = await runHandler(
        { op: 'fetch', requestContext: {}, queryStringParameters: { token: 'anything' } },
        env,
        {},
        { weather: async () => '72F' },
      );
      expect(result.statusCode).toBe(403);
    });

    it('rejects an HTTP-triggered fetch with 403 when the token does not match', async () => {
      const env = { ...baseEnv, DB_PATH: join(dir, 'memory.db'), FETCH_TRIGGER_TOKEN: 'correct-token' };
      const result = await runHandler(
        { op: 'fetch', requestContext: {}, queryStringParameters: { token: 'wrong-token' } },
        env,
        {},
        { weather: async () => '72F' },
      );
      expect(result.statusCode).toBe(403);
    });

    it('rejects an HTTP-triggered fetch with 403 when no token is supplied', async () => {
      const env = { ...baseEnv, DB_PATH: join(dir, 'memory.db'), FETCH_TRIGGER_TOKEN: 'correct-token' };
      const result = await runHandler({ op: 'fetch', requestContext: {} }, env, {}, { weather: async () => '72F' });
      expect(result.statusCode).toBe(403);
    });

    it('runs an HTTP-triggered fetch when the token matches', async () => {
      s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' }); // bootstrap
      s3.on(PutObjectCommand).resolves({ ETag: '"v1"' });
      bedrock.on(ConverseCommand).resolves({
        output: { message: { role: 'assistant', content: [{ text: 'Weather update: 72F' }] } },
        stopReason: 'end_turn',
      });

      const env = { ...baseEnv, DB_PATH: join(dir, 'memory.db'), FETCH_TRIGGER_TOKEN: 'correct-token' };
      const result = await runHandler(
        { op: 'fetch', requestContext: {}, queryStringParameters: { token: 'correct-token' } },
        env,
        { s3Client: s3 as unknown as S3Client, bedrockClient: bedrock as unknown as BedrockRuntimeClient },
        { weather: async () => '72F' },
      );
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body ?? '{}');
      expect(body.outcome).toBe('success');
    });

    it('runs an EventBridge-triggered fetch regardless of FETCH_TRIGGER_TOKEN (no requestContext, trusted by construction)', async () => {
      s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' }); // bootstrap
      s3.on(PutObjectCommand).resolves({ ETag: '"v1"' });
      bedrock.on(ConverseCommand).resolves({
        output: { message: { role: 'assistant', content: [{ text: 'Weather update: 72F' }] } },
        stopReason: 'end_turn',
      });

      const env = { ...baseEnv, DB_PATH: join(dir, 'memory.db') }; // token unset
      const result = await runHandler(
        { op: 'fetch' }, // EventBridge's literal payload — no requestContext
        env,
        { s3Client: s3 as unknown as S3Client, bedrockClient: bedrock as unknown as BedrockRuntimeClient },
        { weather: async () => '72F' },
      );
      expect(result.statusCode).toBe(200);
    });

    it('makes exactly one Converse call per tick even with two sources configured', async () => {
      s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' }); // bootstrap
      s3.on(PutObjectCommand).resolves({ ETag: '"v1"' });
      bedrock.on(ConverseCommand).resolves({
        output: { message: { role: 'assistant', content: [{ text: 'A short friendly comment.\n\nA haiku here.' }] } },
        stopReason: 'end_turn',
      });

      const env = {
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        SNAPSHOT_BUCKET: 'test-bucket',
        DB_PATH: join(dir, 'memory.db'),
        SOURCES: '["weather", "crypto"]',
      };

      const result = await runHandler(
        { op: 'fetch' },
        env,
        { s3Client: s3 as unknown as S3Client, bedrockClient: bedrock as unknown as BedrockRuntimeClient },
        {
          weather: async () => '72F',
          crypto: async () => '67234.10',
        },
      );

      expect(result.statusCode).toBe(200);
      // The combined-message reformulation means exactly one formatter call per tick,
      // regardless of source count — the per-source loop is gone.
      expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
      // The embed call also runs once per tick (not per source) — the test must pin
      // this so a regression that fans the embed out per source fails loudly. Without
      // this assertion, the InvokeModelCommand stub in beforeEach would silently absorb
      // any number of calls and the test would still pass.
      expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(1);
      // And the Discord poster must actually post exactly once — without asserting this,
      // a swallowed fetch failure (the real fetch is spied in beforeEach) would let
      // runFetch catch the error and return success.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetchArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(fetchArgs[0]).toBe('https://discord.example/webhook');
      expect(JSON.parse(String(fetchArgs[1].body))).toMatchObject({ content: expect.any(String) });
    });
  });
});
