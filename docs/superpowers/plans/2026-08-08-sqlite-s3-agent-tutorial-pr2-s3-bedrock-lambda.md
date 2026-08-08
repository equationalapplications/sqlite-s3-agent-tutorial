# SQLite S3 Agent Tutorial — PR2: S3 Rehydration + Lambda + Bedrock (Phases 2-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on:** PR1 (`2026-08-08-sqlite-s3-agent-tutorial-pr1-local.md`) must be merged first. This plan assumes `src/agent/fetch.ts`, `src/store/types.ts`, `src/format/types.ts`, `src/config.ts`, and all PR1 tests exist and pass.

**Goal:** Add `S3Store` (real S3 rehydration behind the `Store` interface from PR1), `BedrockFormatter` (real LLM formatting behind the `MessageFormatter` interface from PR1), and deploy the writer as a Lambda via CDK with EventBridge scheduling. This covers Phase 2 and Phase 3 of the design spec (§9). The `status` reader op is explicitly out of scope — PR3 adds it.

**Architecture:** `src/agent/fetch.ts` does not change in this PR — it already depends only on the `Store` and `MessageFormatter` interfaces from PR1. This PR adds a second implementation of each (`S3Store`, `BedrockFormatter`) and wires them together in `src/handler.ts`, the Lambda entry point. IAM and Bedrock request-shape handling follow the pattern proven in `aws-cloud-agent/src/bedrock/families.ts` and `aws-cloud-agent/infra/stack.ts`, trimmed to the three families this tutorial's spec documents (§12.2-12.3): `zai` (default), `amazon.nova`, `anthropic.claude`.

**Tech Stack:** Adds `@aws-sdk/client-s3`, `@aws-sdk/client-bedrock-runtime`, `aws-sdk-client-mock` (dev), `@smithy/util-stream` (dev, for streaming test fixtures), `aws-cdk`, `aws-cdk-lib`, `constructs` (dev) to the PR1 stack.

---

## File Structure (additions to PR1)

```
sqlite-s3-agent-tutorial/
├── infra/
│   ├── stack.ts                     # CDK: bucket, function, schedule
│   └── cdk.json
├── src/
│   ├── config.ts                    # MODIFY: add region, snapshotBucket, snapshotKey, bedrock* fields
│   ├── store/
│   │   └── s3.ts                    # S3Store — Store against S3 with If-Match
│   ├── format/
│   │   ├── families.ts              # model family registry (zai, amazon.nova, anthropic.claude)
│   │   └── bedrock.ts                # BedrockFormatter
│   └── handler.ts                   # Lambda entry: op="fetch" wired, op="status" stubbed (PR3 completes it)
├── scripts/
│   └── deploy.sh
├── tests/
│   ├── s3.test.ts                    # aws-sdk-client-mock
│   ├── families.test.ts
│   └── bedrock.test.ts               # aws-sdk-client-mock
├── Dockerfile
└── package.json                     # MODIFY: add AWS SDK deps, cdk scripts
```

---

## Task 1: Add AWS/CDK dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json`**

Add to `"scripts"`:

```json
    "cdk": "cdk",
    "deploy": "bash scripts/deploy.sh"
```

Add to `"dependencies"`:

```json
    "@aws-sdk/client-bedrock-runtime": "^3.1103.0",
    "@aws-sdk/client-s3": "^3.1103.0"
```

Add to `"devDependencies"`:

```json
    "@smithy/util-stream": "^4.7.16",
    "aws-cdk": "^2.1135.0",
    "aws-cdk-lib": "^2.263.0",
    "aws-sdk-client-mock": "^4.1.0",
    "constructs": "^10.8.1"
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: no errors, `package-lock.json` updated.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add AWS SDK and CDK dependencies"
```

---

## Task 2: `S3Store`

**Files:**
- Create: `src/store/s3.ts`
- Test: `tests/s3.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/s3.test.ts
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createS3Store } from '../src/store/s3.js';
import { PreconditionFailedError } from '../src/store/types.js';

const s3 = mockClient(S3Client);

function s3Body(content: string) {
  return sdkStreamMixin(Readable.from([content]));
}

describe('S3Store', () => {
  beforeEach(() => s3.reset());
  afterEach(() => s3.reset());

  const store = createS3Store({
    client: new S3Client({ region: 'us-east-1' }),
    bucket: 'test-bucket',
  });

  describe('head', () => {
    it('returns the etag when the object exists', async () => {
      s3.on(HeadObjectCommand).resolves({ ETag: '"abc123"' });
      const result = await store.head('memory.db');
      expect(result).toEqual({ etag: '"abc123"' });
    });

    it('returns null on NotFound', async () => {
      s3.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      const result = await store.head('memory.db');
      expect(result).toBeNull();
    });

    it('propagates non-404 errors', async () => {
      s3.on(HeadObjectCommand).rejects(new Error('AccessDenied'));
      await expect(store.head('memory.db')).rejects.toThrow('AccessDenied');
    });
  });

  describe('get', () => {
    it('returns etag and body when the object exists', async () => {
      s3.on(GetObjectCommand).resolves({ ETag: '"abc123"', Body: s3Body('sqlite content') });
      const result = await store.get('memory.db');
      expect(result?.etag).toBe('"abc123"');
      expect(result?.body.toString()).toBe('sqlite content');
    });

    it('returns null on NoSuchKey (bootstrap case)', async () => {
      s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' });
      const result = await store.get('memory.db');
      expect(result).toBeNull();
    });

    it('propagates non-404 errors', async () => {
      s3.on(GetObjectCommand).rejects(new Error('AccessDenied'));
      await expect(store.get('memory.db')).rejects.toThrow('AccessDenied');
    });
  });

  describe('put', () => {
    it('sends If-Match when ifMatch is non-null', async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"def456"' });
      const result = await store.put('memory.db', Buffer.from('data'), '"abc123"');

      expect(result.etag).toBe('"def456"');
      const calls = s3.commandCalls(PutObjectCommand);
      expect(calls[0]?.args[0].input?.IfMatch).toBe('"abc123"');
    });

    it('omits If-Match when ifMatch is null (bootstrap put)', async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
      await store.put('memory.db', Buffer.from('data'), null);

      const calls = s3.commandCalls(PutObjectCommand);
      expect(calls[0]?.args[0].input?.IfMatch).toBeUndefined();
    });

    it('throws PreconditionFailedError on 412', async () => {
      s3.on(PutObjectCommand).rejects({ name: 'PreconditionFailed' });
      await expect(
        store.put('memory.db', Buffer.from('data'), '"abc123"'),
      ).rejects.toThrow(PreconditionFailedError);
    });

    it('propagates non-412 errors', async () => {
      s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));
      await expect(
        store.put('memory.db', Buffer.from('data'), '"abc123"'),
      ).rejects.toThrow('AccessDenied');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/s3.test.ts`
Expected: FAIL — `Cannot find module '../src/store/s3.js'`

- [ ] **Step 3: Write `src/store/s3.ts`**

```typescript
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { PreconditionFailedError, type Store } from './types.js';

export interface S3StoreOptions {
  client: S3Client;
  bucket: string;
}

function isNoSuchKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'NoSuchKey';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'NotFound';
}

function isPreconditionFailed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'PreconditionFailed'
  );
}

/**
 * `Store` backed by S3 (spec §4.2). The `ifMatch: string | null` contract is translated
 * to S3's wire semantics here and nowhere else: `null` omits the `If-Match` header
 * entirely (a bootstrap put — there is no prior version to match against), a non-null
 * value becomes `If-Match: <etag>`. Callers never see this translation.
 */
export function createS3Store(options: S3StoreOptions): Store {
  return {
    async head(key: string) {
      try {
        const response = await options.client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        return { etag: response.ETag ?? '' };
      } catch (error: unknown) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async get(key: string) {
      try {
        const response = await options.client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        const body = await response.Body?.transformToByteArray();
        if (body === undefined) {
          throw new Error(`S3 object ${key} has no body`);
        }
        return { etag: response.ETag ?? '', body: Buffer.from(body) };
      } catch (error: unknown) {
        if (isNoSuchKey(error)) return null;
        throw error;
      }
    },

    async put(key: string, body: Buffer, ifMatch: string | null) {
      try {
        const response = await options.client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: body,
            ContentType: 'application/vnd.sqlite3',
            ...(ifMatch === null ? {} : { IfMatch: ifMatch }),
          }),
        );
        return { etag: response.ETag ?? '' };
      } catch (error: unknown) {
        if (isPreconditionFailed(error)) {
          throw new PreconditionFailedError();
        }
        throw error;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/s3.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/store/s3.ts tests/s3.test.ts
git commit -m "feat: add S3Store implementing the Store interface"
```

---

## Task 3: Bedrock model family registry

**Files:**
- Create: `src/format/families.ts`
- Test: `tests/families.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/families.test.ts
import { describe, expect, it } from 'vitest';
import { resolveFamily } from '../src/format/families.js';

describe('resolveFamily', () => {
  it('resolves zai.glm-4.7-flash to the zai family with a bare prefix', () => {
    const family = resolveFamily('zai.glm-4.7-flash');
    expect(family.id).toBe('zai');
    expect(family.prefixes).toEqual(['']);
  });

  it('resolves amazon.nova-* to the amazon-nova family', () => {
    const family = resolveFamily('amazon.nova-lite-v1:0');
    expect(family.id).toBe('amazon-nova');
    expect(family.prefixes).toEqual(['', 'us.']);
  });

  it('resolves anthropic.claude-* to the anthropic-claude family', () => {
    const family = resolveFamily('anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(family.id).toBe('anthropic-claude');
    expect(family.prefixes).toEqual(['global.', 'us.']);
  });

  it('throws for an unknown model id', () => {
    expect(() => resolveFamily('made-up.model-1')).toThrow(/no known model family/);
  });

  it('throws when the base id already carries a known prefix', () => {
    expect(() => resolveFamily('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toThrow(
      /already carries/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/families.test.ts`
Expected: FAIL — `Cannot find module '../src/format/families.js'`

- [ ] **Step 3: Write `src/format/families.ts`**

```typescript
/**
 * Which inference-profile prefixes a Bedrock model family accepts (spec §12.3). Verified
 * against Bedrock, never inferred from a model's name — see the sibling repo's design
 * spec (`aws-cloud-agent/docs/superpowers/specs/2026-08-02-model-provider-adapter-design.md`
 * §5) for the live-probe procedure, including the mandatory negative control.
 */
export interface ModelFamily {
  readonly id: string;
  readonly matchesModelId: (baseModelId: string) => boolean;
  /** Accepted inference-profile prefixes, default first. Empty string means bare id. */
  readonly prefixes: readonly string[];
}

const KNOWN_PREFIXES = ['global.', 'us.'] as const;

export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze([
  Object.freeze({
    id: 'zai',
    // ON_DEMAND inference type — bare id only, no global./us. inference profile.
    matchesModelId: (id: string) => id.startsWith('zai.'),
    prefixes: Object.freeze(['']),
  }),
  Object.freeze({
    id: 'amazon-nova',
    // global. is an invalid identifier for Nova.
    matchesModelId: (id: string) => id.startsWith('amazon.nova-'),
    prefixes: Object.freeze(['', 'us.']),
  }),
  Object.freeze({
    id: 'anthropic-claude',
    // global. is the default; us. is valid for US-only routing.
    matchesModelId: (id: string) => id.startsWith('anthropic.claude-'),
    prefixes: Object.freeze(['global.', 'us.']),
  }),
]);

/**
 * Derives a model's family from its base id. Throws rather than guessing: an unmatched id
 * is a startup error (spec §11 "an unknown id fails startup, not first invoke"), and a
 * prefix already present on the configured id is rejected because the prefix is supplied
 * by the family, not the user (spec §12.3).
 */
export function resolveFamily(baseModelId: string): ModelFamily {
  const carriedPrefix = KNOWN_PREFIXES.find((p) => baseModelId.startsWith(p));
  if (carriedPrefix !== undefined) {
    throw new Error(
      `Model id "${baseModelId}" already carries the inference-profile prefix ` +
        `"${carriedPrefix}". Configure the base id only; the prefix is supplied by the ` +
        `model's family.`,
    );
  }

  const family = MODEL_FAMILIES.find((candidate) => candidate.matchesModelId(baseModelId));
  if (family === undefined) {
    throw new Error(
      `Model id "${baseModelId}" matches no known model family. Known families: ` +
        `${MODEL_FAMILIES.map((f) => f.id).join(', ')}. Add one only after a live probe ` +
        `against Bedrock (see aws-cloud-agent's model-provider-adapter design spec §5).`,
    );
  }
  return family;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/families.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/format/families.ts tests/families.test.ts
git commit -m "feat: add Bedrock model family registry (zai, amazon-nova, anthropic-claude)"
```

---

## Task 4: Config additions (S3 + Bedrock fields)

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `config.region` is `undefined`, no `SNAPSHOT_BUCKET` validation yet

- [ ] **Step 3: Modify `src/config.ts`**

Add the import and extend `AgentConfig` and `loadConfig`:

```typescript
import { resolveFamily } from './format/families.js';
```

Extend the `AgentConfig` interface:

```typescript
export interface AgentConfig {
  readonly dbPath: string;
  readonly discordWebhookUrl: string;
  readonly sources: readonly SourceName[];

  readonly region: string;
  readonly snapshotBucket: string;
  readonly snapshotKey: string;

  readonly bedrockModelId: string;
  readonly bedrockRegion: string;
  readonly bedrockMaxOutputTokens: number;

  readonly reservedConcurrency: number;
}
```

Add a `num` helper and validate `bedrockModelId` at load, then extend the returned object:

```typescript
function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a finite number, got: ${raw}`);
  }
  return parsed;
}
```

Replace the `return Object.freeze({...})` block in `loadConfig` with:

```typescript
export function loadConfig(env: Env = process.env): AgentConfig {
  const bedrockModelId = str(env, 'BEDROCK_MODEL_ID', 'zai.glm-4.7-flash');
  // Resolved at load, not first invoke (spec §11): an unknown id is a startup error.
  resolveFamily(bedrockModelId);

  return Object.freeze({
    dbPath: str(env, 'DB_PATH', '/tmp/memory.db'),
    discordWebhookUrl: required(env, 'DISCORD_WEBHOOK_URL'),
    sources: sources(env),

    region: str(env, 'AWS_REGION', 'us-east-1'),
    snapshotBucket: required(env, 'SNAPSHOT_BUCKET'),
    snapshotKey: str(env, 'SNAPSHOT_KEY', 'memory.db'),

    bedrockModelId,
    bedrockRegion: str(env, 'BEDROCK_REGION', 'us-east-1'),
    bedrockMaxOutputTokens: num(env, 'BEDROCK_MAX_OUTPUT_TOKENS', 512),

    reservedConcurrency: num(env, 'RESERVED_CONCURRENCY', 1),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: extend config with S3 and Bedrock fields"
```

---

## Task 5: `BedrockFormatter`

**Files:**
- Create: `src/format/bedrock.ts`
- Test: `tests/bedrock.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/bedrock.test.ts
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBedrockFormatter } from '../src/format/bedrock.js';

const bedrock = mockClient(BedrockRuntimeClient);

function textResponse(text: string) {
  return {
    output: { message: { content: [{ text }] } },
    stopReason: 'end_turn',
  };
}

describe('createBedrockFormatter', () => {
  beforeEach(() => bedrock.reset());
  afterEach(() => bedrock.reset());

  const client = new BedrockRuntimeClient({ region: 'us-east-1' });

  it('calls Converse with the configured model id and returns the response text', async () => {
    bedrock.on(ConverseCommand).resolves(textResponse('Looks like 72F today!'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    const message = await formatter.format('weather', '72F');
    expect(message).toBe('Looks like 72F today!');

    const calls = bedrock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input?.modelId).toBe('zai.glm-4.7-flash');
  });

  it('throws a descriptive error on AccessDeniedException', async () => {
    bedrock.on(ConverseCommand).rejects({ name: 'AccessDeniedException', message: 'denied' });

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format('weather', '72F')).rejects.toThrow(/model access/i);
  });

  it('throws a descriptive error on ResourceNotFoundException naming the model id and region', async () => {
    bedrock.on(ConverseCommand).rejects({ name: 'ResourceNotFoundException', message: 'not found' });

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format('weather', '72F')).rejects.toThrow(/zai\.glm-4\.7-flash/);
    await expect(formatter.format('weather', '72F')).rejects.toThrow(/us-east-1/);
  });

  it('throws on a malformed response with no content, no retry', async () => {
    bedrock.on(ConverseCommand).resolves({ output: { message: { content: [] } }, stopReason: 'end_turn' });

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format('weather', '72F')).rejects.toThrow(/no text/i);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
  });

  it('retries once on ThrottlingException, then succeeds', async () => {
    bedrock
      .on(ConverseCommand)
      .rejectsOnce({ name: 'ThrottlingException', message: 'slow down' })
      .resolves(textResponse('formatted after retry'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    const message = await formatter.format('weather', '72F');
    expect(message).toBe('formatted after retry');
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('retries once on ThrottlingException, then throws if it fails again', async () => {
    bedrock.on(ConverseCommand).rejects({ name: 'ThrottlingException', message: 'slow down' });

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await expect(formatter.format('weather', '72F')).rejects.toThrow(/Throttl/);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bedrock.test.ts`
Expected: FAIL — `Cannot find module '../src/format/bedrock.js'`

- [ ] **Step 3: Write `src/format/bedrock.ts`**

```typescript
import { type BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { SourceName } from '../db/schema.js';
import type { MessageFormatter } from './types.js';

export interface BedrockFormatterOptions {
  client: BedrockRuntimeClient;
  modelId: string;
  region: string;
  maxOutputTokens: number;
}

const RETRY_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_PROMPT =
  'You write a single short, friendly Discord notification message announcing a new ' +
  'value for a tracked data source. Reply with the message text only — no quotes, no ' +
  'preamble, no markdown formatting.';

function buildUserPrompt(source: SourceName, rawValue: string): string {
  return `Source: ${source}\nNew value: ${rawValue}`;
}

/** Maps a Bedrock exception to a message naming the fix (spec §6, §12.4). */
function mapBedrockError(error: unknown, options: BedrockFormatterOptions): Error {
  const { modelId, region } = options;
  const where = `model "${modelId}", region ${region}`;
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name ?? 'UnknownError';
  const detail = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);

  switch (name) {
    case 'AccessDeniedException':
      return new Error(
        `Bedrock model access is not granted for ${where}. Enable the model in the ` +
          `Bedrock console's Model access page for this account and region (spec §12.1). ` +
          `Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ValidationException':
      return new Error(
        `Bedrock rejected the request for ${where}. This is almost always a model-family ` +
          `mismatch (spec §12.3) — re-probe the model's accepted request shape before ` +
          `changing src/format/families.ts. Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ResourceNotFoundException':
      return new Error(
        `Bedrock does not recognise the model id for ${where}. Check that bedrockModelId ` +
          `is the base id with no inference-profile prefix — the prefix is supplied by the ` +
          `family (spec §12.3). Underlying error: ${detail}`,
        { cause: error },
      );
    default:
      return new Error(`Bedrock call failed for ${where} with ${name}: ${detail}`, { cause: error });
  }
}

function isThrottlingOr5xx(error: unknown): boolean {
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name;
  return name === 'ThrottlingException' || name === 'InternalServerException' || name === 'ServiceUnavailableException';
}

/**
 * `MessageFormatter` backed by Amazon Bedrock's Converse API (spec §2, §12). Default
 * model is `zai.glm-4.7-flash`, resolved and validated by `src/config.ts` at load time.
 *
 * One retry on `ThrottlingException`/5xx with a fixed ~500ms backoff (spec §6); every
 * other exception is not retried — access and validation failures are not transient.
 */
export function createBedrockFormatter(options: BedrockFormatterOptions): MessageFormatter {
  async function attempt(source: SourceName, rawValue: string): Promise<string> {
    const response = await options.client.send(
      new ConverseCommand({
        modelId: options.modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: buildUserPrompt(source, rawValue) }] }],
        inferenceConfig: { maxTokens: options.maxOutputTokens },
      }),
    );

    const text = (response.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
    if (text === '') {
      throw new Error(`Bedrock returned no text (stopReason: ${response.stopReason ?? 'unknown'})`);
    }
    return text;
  }

  return {
    async format(source: SourceName, rawValue: string): Promise<string> {
      try {
        return await attempt(source, rawValue);
      } catch (error: unknown) {
        if (isThrottlingOr5xx(error)) {
          await delay(RETRY_DELAY_MS);
          try {
            return await attempt(source, rawValue);
          } catch (retryError: unknown) {
            throw mapBedrockError(retryError, options);
          }
        }
        if (error instanceof Error && error.message.startsWith('Bedrock returned no text')) {
          throw error; // malformed response — not retried, message is already descriptive
        }
        throw mapBedrockError(error, options);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bedrock.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/format/bedrock.ts tests/bedrock.test.ts
git commit -m "feat: add BedrockFormatter with retry and descriptive error mapping"
```

---

## Task 6: Lambda handler (`fetch` op wired, `status` stubbed)

**Files:**
- Create: `src/handler.ts`
- Test: `tests/handler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
      output: { message: { content: [{ text: 'Weather update: 72F' }] } },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handler.test.ts`
Expected: FAIL — `Cannot find module '../src/handler.js'`

- [ ] **Step 3: Write `src/handler.ts`**

```typescript
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { runFetch } from './agent/fetch.js';
import { loadConfig } from './config.js';
import { createFetchDiscordPoster } from './discord/poster.js';
import { createBedrockFormatter } from './format/bedrock.js';
import { createSourceFetcher } from './sources/index.js';
import type { SourceFetcher, SourceName } from './sources/types.js';
import { createS3Store } from './store/s3.js';

interface HandlerEvent {
  op: string;
}

interface LambdaResult {
  statusCode: number;
  body?: string;
}

interface InjectedClients {
  s3Client?: S3Client;
  bedrockClient?: BedrockRuntimeClient;
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
  if (event.op !== 'fetch' && event.op !== 'status') {
    return { statusCode: 400, body: JSON.stringify({ error: `Unknown op: ${event.op}` }) };
  }

  const config = loadConfig(env);

  if (event.op === 'status') {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handler.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all PR1 + PR2 tests pass

- [ ] **Step 7: Commit**

```bash
git add src/handler.ts tests/handler.test.ts
git commit -m "feat: add Lambda handler routing fetch to the writer, status stubbed for PR3"
```

---

## Task 7: Dockerfile (arm64)

**Files:**
- Create: `Dockerfile`

No automated test — verified by building the image in Task 9's deploy step. Manual
verification: `docker build --platform linux/arm64 -t sqlite-s3-agent-tutorial .` succeeds.

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# ---- build stage (arm64, same architecture as the runtime stage and the Lambda) ----
FROM node:24-bookworm-slim AS build

WORKDIR /build

# Toolchain for better-sqlite3's native addon. Build and runtime stages share an
# architecture and Debian release, so this compiles natively — no cross-compile flags,
# no risk of a binary built against one glibc running against a different one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.check.json ./
COPY src/ src/

RUN npm run build

# ---- runtime stage (arm64) ----
FROM node:24-bookworm-slim AS runtime

WORKDIR /var/task

# Lambda runtime interface client. No prebuilt binary for this base image — its install
# step builds against a small toolchain, which is purged in the same layer so it never
# reaches the shipped image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake g++ make autoconf automake libtool pkg-config python3 \
      xz-utils curl ca-certificates libssl-dev zlib1g-dev libcurl4-openssl-dev \
    && npm install -g aws-lambda-ric \
    && apt-get purge -y cmake g++ make autoconf automake libtool pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=build /build/node_modules/ ./node_modules/
COPY --from=build /build/dist/ ./dist/

RUN mkdir -p /tmp && chmod 777 /tmp

ENTRYPOINT ["aws-lambda-ric"]
CMD ["dist/handler.handler"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add arm64 Lambda container image"
```

---

## Task 8: CDK stack

**Files:**
- Create: `infra/stack.ts`
- Create: `infra/cdk.json`

No unit test — verified by `cdk synth` (Task 9). This mirrors `aws-cloud-agent/infra/stack.ts`'s
structure, trimmed to one function and the three families from Task 3.

- [ ] **Step 1: Write `infra/cdk.json`**

```json
{
  "app": "npx tsx infra/stack.ts",
  "context": {
    "@aws-cdk/core:stackRelativeExports": true
  }
}
```

- [ ] **Step 2: Write `infra/stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';

const STACK_NAME = 'SqliteS3AgentTutorial';
const IMAGE_DIR = '.';

interface AgentStackProps extends cdk.StackProps {
  bedrockModelId?: string;
}

/**
 * Provisions the full tutorial substrate: one bucket, one Lambda function (both ops), one
 * EventBridge schedule, one Function URL (spec §2). `reservedConcurrentExecutions: 1`
 * enforces the single-writer invariant (spec §2).
 */
class AgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps = {}) {
    super(scope, id, props);

    const bedrockModelId = props.bedrockModelId ?? 'zai.glm-4.7-flash';

    // ---- S3 bucket ----

    const bucket = new s3.Bucket(this, 'SnapshotBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Tutorial-quality cleanup ergonomics (spec §9): cdk destroy must succeed even
      // when the bucket holds the SQLite snapshot. Production code generally wants
      // RemovalPolicy.RETAIN and explicit lifecycle ownership instead.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- Log group ----

    const logGroup = new logs.LogGroup(this, 'AgentLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- Lambda function (one image, one function, both ops) ----

    const environment: Record<string, string> = {
      SNAPSHOT_BUCKET: bucket.bucketName,
      BEDROCK_MODEL_ID: bedrockModelId,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const agentFunction = new lambda.DockerImageFunction(this, 'AgentFunction', {
      code: lambda.DockerImageCode.fromImageAsset(IMAGE_DIR, {
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      // Single-writer invariant (spec §2): without this, two overlapping `fetch`
      // invocations could both hydrate the same version and silently overwrite each
      // other's writes.
      reservedConcurrentExecutions: 1,
      logGroup,
      environment,
    });

    bucket.grantReadWrite(agentFunction);

    // ---- Bedrock IAM ----

    const bedrockPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
      resources: buildBedrockResources(bedrockModelId, this.region),
    });
    agentFunction.addToRolePolicy(bedrockPolicy);

    // ---- Function URL (status reads, PR3 completes the op) ----

    const functionUrl = agentFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ---- EventBridge schedule (op: fetch, once a day) ----

    // Constant JSON input, not a transformed event payload (spec §2): the handler reads
    // event.op directly without unwrapping EventBridge's own envelope shape.
    new events.Rule(this, 'FetchSchedule', {
      enabled: true,
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [
        new targets.LambdaFunction(agentFunction, {
          event: events.RuleTargetInput.fromObject({ op: 'fetch' }),
        }),
      ],
    });

    // ---- Outputs ----

    new cdk.CfnOutput(this, 'SnapshotBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'AgentFunctionName', { value: agentFunction.functionName });
    new cdk.CfnOutput(this, 'AgentFunctionUrl', { value: functionUrl.url });
  }
}

/**
 * Builds the Bedrock resource ARNs for the IAM policy, narrowed to the configured model's
 * family (spec §12.2) — a wildcard grant across all families is the deliberate rejected
 * alternative; picking a model whose family this function does not know produces a
 * narrower-than-intended grant, surfacing as AccessDeniedException at first invoke rather
 * than at synth.
 */
function buildBedrockResources(bedrockModelId: string, region: string): string[] {
  const account = cdk.Aws.ACCOUNT_ID;

  if (bedrockModelId.startsWith('zai.')) {
    return [`arn:aws:bedrock:${region}::foundation-model/zai.*`];
  }
  if (bedrockModelId.startsWith('amazon.nova-')) {
    return [
      `arn:aws:bedrock:${region}::foundation-model/amazon.nova-*`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/us.amazon.nova-*`,
    ];
  }
  if (bedrockModelId.startsWith('anthropic.claude-')) {
    return [
      `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/global.anthropic.claude-*`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-*`,
    ];
  }

  throw new Error(
    `bedrockModelId "${bedrockModelId}" matches no known family in infra/stack.ts's ` +
      `buildBedrockResources. Add a branch here matching the entry added to ` +
      `src/format/families.ts.`,
  );
}

// ---- App entry point ----

const app = new cdk.App();

new AgentStack(app, STACK_NAME, {
  env: {
    ...(process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT } : {}),
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  ...(process.env.BEDROCK_MODEL_ID ? { bedrockModelId: process.env.BEDROCK_MODEL_ID } : {}),
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.check.json`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add infra/stack.ts infra/cdk.json
git commit -m "feat: add CDK stack (bucket, Lambda, EventBridge schedule, Function URL)"
```

---

## Task 9: Deploy script and first deploy

**Files:**
- Create: `scripts/deploy.sh`

- [ ] **Step 1: Write `scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="SqliteS3AgentTutorial"

echo "=== Bootstrapping CDK (if needed) ==="
npx cdk bootstrap \
  --profile "$PROFILE" \
  "aws://$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)/$REGION"

echo "=== Building TypeScript ==="
npm run build

echo "=== Synthesising ==="
npx cdk synth --app "npx tsx infra/stack.ts" --profile "$PROFILE"

echo "=== Deploying ==="
npx cdk deploy --app "npx tsx infra/stack.ts" --profile "$PROFILE" --require-approval never

echo "=== Deployment complete ==="
aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output table
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/deploy.sh`

- [ ] **Step 3: Manual verification (requires AWS credentials and Bedrock model access granted per spec §12.1)**

Run:
```bash
export AWS_PROFILE=your-profile
export SNAPSHOT_BUCKET_PLACEHOLDER_NOTE="bucket name is generated by CDK, not set manually"
npm run deploy
```
Expected: stack deploys, outputs table shows `SnapshotBucketName`, `AgentFunctionName`,
`AgentFunctionUrl`. Before this step, confirm the model access console step from spec
§12.1 has been completed for `zai.glm-4.7-flash` in `us-east-1` — otherwise the deploy
succeeds but the first `fetch` invoke fails with `AccessDeniedException`.

Invoke the writer:
```bash
aws lambda invoke --profile "$AWS_PROFILE" --region us-east-1 \
  --function-name <AgentFunctionName from outputs> \
  --payload '{"op":"fetch"}' --cli-binary-format raw-in-base64-out \
  /tmp/fetch-response.json
cat /tmp/fetch-response.json
```
Expected: `{"outcome":"success",...}`. Verify the bucket has `memory.db`:
`aws s3 ls s3://<SnapshotBucketName>/`

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat: add scripts/deploy.sh"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §4.2 conditional write (Task 2), §12.2/§12.3 IAM and prefix rules
  (Task 3, Task 8's `buildBedrockResources`), §6 Bedrock error table (Task 5), §11 S3/Bedrock
  config fields (Task 4), Phase 3 deliverables — container image, CDK stack, EventBridge
  schedule, Function URL, Bedrock IAM, reserved concurrency 1, `scripts/deploy.sh` (Tasks
  6-9) — are all covered. The `status` op, `agent_runs` population verification via the
  reader, and `scripts/smoke.sh` are explicitly deferred to PR3 per the spec's own Phase
  3/Phase 4 split (§9).
- **Type consistency:** `Store` and `MessageFormatter` interfaces are imported from PR1's
  `src/store/types.ts` and `src/format/types.ts` unchanged — `S3Store` and
  `BedrockFormatter` satisfy them without modification, confirmed by `tsc` in Task 5 Step 5
  and Task 6 Step 5. `SourceName` continues to resolve to the single definition in
  `src/db/schema.ts` (PR1).
