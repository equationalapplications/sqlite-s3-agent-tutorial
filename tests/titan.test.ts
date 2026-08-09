import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Uint8ArrayBlobAdapter } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTitanEmbedder } from '../src/embed/titan.js';

const bedrock = mockClient(BedrockRuntimeClient);

// The SDK's real InvokeModelCommandOutput.body is a Uint8ArrayBlobAdapter (adds
// transformToString on top of Uint8Array) — a plain TextEncoder().encode() Uint8Array
// doesn't satisfy that type under this repo's strict typecheck.
function embeddingResponse(embedding: number[]) {
  return {
    body: Uint8ArrayBlobAdapter.mutate(
      new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: embedding.length })),
    ),
    contentType: 'application/json',
  };
}

describe('createTitanEmbedder', () => {
  beforeEach(() => bedrock.reset());
  afterEach(() => bedrock.reset());

  const client = new BedrockRuntimeClient({ region: 'us-east-1' });
  const vector256 = Array.from({ length: 256 }, (_, i) => i / 256);
  const otherVector256 = Array.from({ length: 256 }, (_, i) => (i + 1) / 256);

  it('calls InvokeModel with the Titan v2 model id, 256 dims, normalize, and returns the embedding', async () => {
    bedrock.on(InvokeModelCommand).resolves(embeddingResponse(vector256));

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    const vector = await embedder.embed('72F');
    expect(vector).toEqual(vector256);

    const calls = bedrock.commandCalls(InvokeModelCommand);
    expect(calls[0]?.args[0].input?.modelId).toBe('amazon.titan-embed-text-v2:0');
    const body = JSON.parse(calls[0]?.args[0].input?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ inputText: '72F', dimensions: 256, normalize: true });
  });

  it('throws a descriptive error on AccessDeniedException', async () => {
    bedrock.on(InvokeModelCommand).rejects({ name: 'AccessDeniedException', message: 'denied' });

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/model access/i);
  });

  it('retries once on ThrottlingException, then succeeds', async () => {
    bedrock
      .on(InvokeModelCommand)
      .rejectsOnce({ name: 'ThrottlingException', message: 'slow down' })
      .resolves(embeddingResponse(otherVector256));

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    const vector = await embedder.embed('72F');
    expect(vector).toEqual(otherVector256);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(2);
  });

  it('retries once on ThrottlingException, then throws if it fails again', async () => {
    bedrock.on(InvokeModelCommand).rejects({ name: 'ThrottlingException', message: 'slow down' });

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/Throttl/);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(2);
  });

  it('throws on a response with no embedding array, no retry', async () => {
    bedrock.on(InvokeModelCommand).resolves({
      body: Uint8ArrayBlobAdapter.mutate(new TextEncoder().encode(JSON.stringify({ inputTextTokenCount: 5 }))),
      contentType: 'application/json',
    });

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/no embedding/i);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(1);
  });

  it('throws on a response with the wrong embedding length, no retry', async () => {
    bedrock.on(InvokeModelCommand).resolves(embeddingResponse([0.1, 0.2, 0.3]));

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/no embedding/i);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(1);
  });

  it('throws on a response with a non-finite entry, no retry', async () => {
    // Hand-craft the response body so JSON.parse produces Infinity: JSON.stringify
    // turns Number.NaN into `null`, which would fail the `typeof === 'number'` check
    // before Number.isFinite ever runs. `1e400` parses to Infinity and exercises the
    // finite-value guard directly.
    const rawBody = `{"embedding":[${[...vector256].map((_, i) => (i === 0 ? '1e400' : String(vector256[i]!))).join(',')}],"inputTextTokenCount":256}`;
    bedrock.on(InvokeModelCommand).resolves({
      body: Uint8ArrayBlobAdapter.mutate(new TextEncoder().encode(rawBody)),
      contentType: 'application/json',
    });

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await expect(embedder.embed('72F')).rejects.toThrow(/no embedding/i);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(1);
  });

  it('passes an AbortSignal to the SDK call, bounded by a request deadline', async () => {
    // Regression for the copilot review on PR #5: each InvokeModel call must
    // carry an AbortSignal so a stalled send() can't eat the 30s Lambda
    // budget before the per-source try/catch in runFetch gets to isolate the
    // failure (RAG design spec §6). The real abort path is exercised in
    // production by the SDK's http handler when the signal fires; this test
    // verifies the wiring.
    bedrock.on(InvokeModelCommand).resolves(embeddingResponse(vector256));

    const embedder = createTitanEmbedder({ client, region: 'us-east-1' });
    await embedder.embed('72F');

    // aws-sdk-client-mock's typed `args` is `[Command]`, but at runtime sinon's
    // stub records both args the SDK passes to `send(command, options)`. Cast
    // through unknown so we can read `args[1]` (HttpHandlerOptions).
    const calls = bedrock.commandCalls(InvokeModelCommand) as unknown as Array<{ args: unknown[] }>;
    const handlerOptions = calls[0]?.args[1] as { abortSignal?: AbortSignal } | undefined;
    const abortSignal = handlerOptions?.abortSignal;
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    expect(abortSignal?.aborted).toBe(false);
  });
});
