// src/handler.ts
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { runFetch } from './agent/fetch.js';
import { loadConfig } from './config.js';
import { createFetchDiscordPoster } from './discord/poster.js';
import { createBedrockFormatter } from './format/bedrock.js';
import { createSourceFetcher } from './sources/index.js';
import type { SourceFetcher, SourceName } from './sources/types.js';
import { createS3Store } from './store/s3.js';

/**
 * Lambda invocation payload (spec §2). EventBridge delivers `{ op: 'fetch' }` directly;
 * Function URL invocations deliver the same JSON as a string under `body`. `op` is
 * optional here because the source may be either field — `resolveOp` picks one.
 */
export interface HandlerEvent {
  op?: string;
  body?: string;
}

export interface LambdaResult {
  statusCode: number;
  body?: string;
}

export interface InjectedClients {
  s3Client?: S3Client;
  bedrockClient?: BedrockRuntimeClient;
}

/**
 * Extracts `op` from the two event shapes the function accepts:
 *   - EventBridge-style: `{ op: 'fetch' }` (op is a top-level field).
 *   - Function URL-style: `{ body: '{"op":"status"}' }` (op is JSON inside the HTTP body).
 * Returns `undefined` when neither yields a string — the caller maps that to 400.
 *
 * Guarded with `typeof === 'string'` so a non-string `event.op` (e.g. an HTTP client
 * that posts `{op: 42}` or `{op: {name: 'fetch'}}`) falls through to body parsing /
 * the 400 path rather than being passed through as a non-string op.
 */
function resolveOp(event: HandlerEvent): string | undefined {
  if (typeof event.op === 'string') return event.op;
  if (event.body !== undefined && event.body !== '') {
    try {
      const parsed = JSON.parse(event.body) as { op?: unknown };
      if (typeof parsed.op === 'string') return parsed.op;
    } catch {
      // body wasn't JSON; fall through and return undefined
    }
  }
  return undefined;
}

/**
 * Lambda entry orchestration, separated from the `handler` export below so tests can
 * inject clients and fake source fetchers without touching `process.env` or the network.
 *
 * `sourceOverrides` lets tests replace the real weather/crypto network calls with canned
 * functions — the same boundary PR1's `fakeSourceFetcher` exercises locally, applied here
 * at the handler level where the real `SourceFetcher` registry would otherwise be used.
 */
export async function runHandler(
  event: HandlerEvent,
  env: Record<string, string | undefined> = process.env,
  clients: InjectedClients = {},
  sourceOverrides: Partial<Record<SourceName, () => Promise<string>>> = {},
): Promise<LambdaResult> {
  const op = resolveOp(event);
  if (op !== 'fetch' && op !== 'status') {
    return { statusCode: 400, body: JSON.stringify({ error: `Unknown op: ${op ?? 'undefined'}` }) };
  }

  const config = loadConfig(env);

  if (op === 'status') {
    // PR3 implements the reader op (spec §9 Phase 4).
    return { statusCode: 501, body: JSON.stringify({ error: 'status op not yet implemented' }) };
  }

  const s3Client = clients.s3Client ?? new S3Client({ region: config.region, maxAttempts: 3 });
  const bedrockClient =
    clients.bedrockClient ?? new BedrockRuntimeClient({ region: config.bedrockRegion, maxAttempts: 3 });

  const store = createS3Store({ client: s3Client, bucket: config.snapshotBucket });
  const formatter = createBedrockFormatter({
    client: bedrockClient,
    modelId: config.bedrockModelId,
    region: config.bedrockRegion,
    maxOutputTokens: config.bedrockMaxOutputTokens,
  });

  const sources: SourceFetcher[] = config.sources.map((name) => {
    const override = sourceOverrides[name];
    if (override !== undefined) {
      return { name, fetch: override };
    }
    return createSourceFetcher(name);
  });

  const result = await runFetch({
    dbPath: config.dbPath,
    store,
    storeKey: config.snapshotKey,
    sources,
    poster: createFetchDiscordPoster(config.discordWebhookUrl),
    formatter,
  });

  return { statusCode: 200, body: JSON.stringify(result) };
}

/** Lambda entry point (`dist/handler.handler` in the CDK stack). */
export async function handler(event: HandlerEvent): Promise<LambdaResult> {
  return runHandler(event, process.env);
}
