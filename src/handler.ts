// src/handler.ts
import { timingSafeEqual } from 'node:crypto';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { runFetch } from './agent/fetch.js';
import { createStatusReader, type StatusReader } from './agent/status.js';
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
  queryStringParameters?: Record<string, string | undefined> | null;
  /**
   * Present only on Function URL invocations, absent on EventBridge's `{op:"fetch"}`
   * literal payload — used purely as a discriminator (`resolveIsHttpTriggered`) to decide
   * whether the fetch-trigger token check applies. Its actual contents are never read.
   */
  requestContext?: unknown;
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
 * Module-scope, keyed by the reader's local path: the Lambda runtime may reuse the
 * container across invocations, so the reader's hydration cache (spec §4.3) must
 * survive warm invocations — recreating it per call would re-download the snapshot on
 * every request regardless of whether its ETag changed.
 */
const statusReaders = new Map<string, StatusReader>();

/**
 * Returns a `StatusReader` whose local SQLite file is a sibling of the writer's, not
 * the writer's file itself. The writer (`runFetch`) writes to `config.dbPath` on every
 * invocation, including the conditional-write failure path where the S3 PutObject is
 * rejected with 412 — in that case the local file is still mutated to record the
 * `outcome='error'` run row, but S3's ETag is unchanged. If the reader shared the
 * writer's path, a subsequent warm `status` call would see an ETag cache hit and
 * answer from the still-open reader handle against the writer's mutated bytes.
 * Keeping the two paths disjoint means the reader's local copy only changes when the
 * reader itself downloads a new snapshot.
 */
function getStatusReader(writerDbPath: string): StatusReader {
  const readerDbPath = `${writerDbPath}.reader`;
  let reader = statusReaders.get(readerDbPath);
  if (reader === undefined) {
    reader = createStatusReader(readerDbPath);
    statusReaders.set(readerDbPath, reader);
  }
  return reader;
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
 * EventBridge's schedule delivers the literal `{op:"fetch"}` payload (spec §2) — no
 * `requestContext`, because it isn't an HTTP request. Function URL invocations always
 * carry one. Used to scope the fetch-trigger token check (below) to HTTP-originated
 * requests only, so the scheduled fetch never needs to know the token exists.
 */
function resolveIsHttpTriggered(event: HandlerEvent): boolean {
  return event.requestContext !== undefined;
}

/**
 * Constant-time comparison so a mismatched token doesn't leak length/prefix information
 * through response timing. Different-length inputs return `false` immediately — that
 * leaks only the fact that lengths differ, not which bytes matched, which is the
 * standard accepted trade-off for this kind of check (Node's `timingSafeEqual` throws on
 * length mismatch rather than handling it).
 */
function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
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
    const s3Client = clients.s3Client ?? new S3Client({ region: config.region, maxAttempts: 3 });
    const store = createS3Store({ client: s3Client, bucket: config.snapshotBucket });
    const reader = getStatusReader(config.dbPath);
    const result = await reader.getStatus(store, config.snapshotKey);
    return { statusCode: 200, body: JSON.stringify(result) };
  }

  // Fetch posts to Discord and calls Bedrock on every invocation — EventBridge's schedule
  // is trusted by construction (its payload is a literal constant this stack itself
  // configures), but an HTTP-triggered fetch is reachable by anyone with the Function URL,
  // so it requires a matching FETCH_TRIGGER_TOKEN. Unset token (the default) rejects all
  // HTTP-triggered fetches rather than defaulting to open (spec: on-demand trigger design).
  if (op === 'fetch' && resolveIsHttpTriggered(event)) {
    const provided = event.queryStringParameters?.token;
    if (config.fetchTriggerToken === null || provided === undefined || !tokensMatch(provided, config.fetchTriggerToken)) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Invalid or missing fetch trigger token' }) };
    }
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
    return createSourceFetcher(name, config.weatherLocation);
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
