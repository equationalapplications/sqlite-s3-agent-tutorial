import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
