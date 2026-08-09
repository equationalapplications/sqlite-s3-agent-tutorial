import { type BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { SourceName } from '../db/schema.js';
import { resolveFamily } from './families.js';
import type { MessageFormatter, SimilarPastResult } from './types.js';

export interface BedrockFormatterOptions {
  client: BedrockRuntimeClient;
  modelId: string;
  region: string;
  maxOutputTokens: number;
}

const RETRY_DELAY_MS = 500;

/**
 * Composes the wire id from the configured base id and the family's default prefix
 * (spec §12.3). The base id alone is not always valid: `anthropic.claude-*` requires
 * a `global.` (or `us.`) inference-profile prefix, and bare-form `amazon.nova-*` does
 * not. `zai.*` accepts the bare form (empty prefix), so for the default model this is
 * a no-op. `resolveFamily` is called again here (after `loadConfig` validates it at
 * startup) so the formatter owns the prefix-composition step rather than requiring
 * `loadConfig` to pre-compose.
 */
function composedModelId(baseModelId: string): string {
  const family = resolveFamily(baseModelId);
  const prefix = family.prefixes[0] ?? '';
  return `${prefix}${baseModelId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_PROMPT =
  'You write a single short, friendly Discord notification message announcing a new ' +
  'value for a tracked data source. Reply with the message text only — no quotes, no ' +
  'preamble, no markdown formatting. If a closest past reading is included below, you ' +
  'may naturally reference it if relevant, but you are not required to.';

function buildUserPrompt(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): string {
  const base = `Source: ${source}\nNew value: ${rawValue}`;
  if (similarPast === null || similarPast === undefined) return base;
  const date = new Date(similarPast.postedAt).toISOString().slice(0, 10);
  return `${base}\nClosest past reading (${date}): "${similarPast.formattedMessage}"`;
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
          `is the base id with no inference-profile prefix — the prefix is supplied by ` +
          `the family (spec §12.3). Underlying error: ${detail}`,
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
  async function attempt(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): Promise<string> {
    const response = await options.client.send(
      new ConverseCommand({
        modelId: composedModelId(options.modelId),
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: buildUserPrompt(source, rawValue, similarPast) }] }],
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
    async format(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): Promise<string> {
      try {
        return await attempt(source, rawValue, similarPast);
      } catch (error: unknown) {
        if (isThrottlingOr5xx(error)) {
          await delay(RETRY_DELAY_MS);
          try {
            return await attempt(source, rawValue, similarPast);
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
