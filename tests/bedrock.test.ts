import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBedrockFormatter } from '../src/format/bedrock.js';

const bedrock = mockClient(BedrockRuntimeClient);

function textResponse(text: string) {
  return {
    output: { message: { role: 'assistant' as const, content: [{ text }] } },
    stopReason: 'end_turn' as const,
  };
}

function emptyResponse() {
  return {
    output: { message: { role: 'assistant' as const, content: [] as never[] } },
    stopReason: 'end_turn' as const,
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

  it('prepends the family default inference-profile prefix (anthropic.claude → global.)', async () => {
    // spec §12.3: anthropic.claude-* requires a `global.` (or `us.`) inference-profile
    // prefix. Without it, Bedrock returns ResourceNotFoundException even when the base
    // id is valid. The base id is configured; the prefix is supplied by the family.
    bedrock.on(ConverseCommand).resolves(textResponse('from claude'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await formatter.format('weather', '72F');

    const calls = bedrock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input?.modelId).toBe(
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  it('includes the closest past reading in the prompt when one is provided', async () => {
    bedrock.on(ConverseCommand).resolves(textResponse('Similar to last time!'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await formatter.format('weather', '73F', {
      formattedMessage: 'Looks like 72F today!',
      postedAt: Date.parse('2026-08-01T00:00:00Z'),
    });

    const calls = bedrock.commandCalls(ConverseCommand);
    const userText = calls[0]?.args[0].input?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(userText).toContain('Looks like 72F today!');
    expect(userText).toContain('2026-08-01');
  });

  it('omits any past-reading line when nearestMatch is null or omitted', async () => {
    bedrock.on(ConverseCommand).resolves(textResponse('No history yet!'));

    const formatter = createBedrockFormatter({
      client,
      modelId: 'zai.glm-4.7-flash',
      region: 'us-east-1',
      maxOutputTokens: 512,
    });

    await formatter.format('weather', '73F', null);

    const calls = bedrock.commandCalls(ConverseCommand);
    const userText = calls[0]?.args[0].input?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(userText).not.toContain('Closest past reading');
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
    bedrock.on(ConverseCommand).resolves(emptyResponse());

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
