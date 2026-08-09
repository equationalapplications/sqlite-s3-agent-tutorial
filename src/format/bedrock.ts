import { type BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { resolveFamily } from './families.js';
import type { LoopContext, MessageFormatter } from './types.js';

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

/**
 * The LLM writes a short friendly comment and a closing haiku. The LLM is *not* told
 * about RAG — the "Reminds me of" suffix is appended mechanically in the writer after
 * the format call returns (loop-mode + poetic-closing spec §4.3). Numerology is
 * deliberately out: the LLM produces cliché numerology platitudes, while a haiku
 * gives the model real creative room and reads as varied across runs.
 */
const SYSTEM_PROMPT =
  'You write a short, friendly Discord message for a check-in bot that posts a ' +
  'combined snapshot of a few tracked values every few minutes. The user ' +
  'message below contains today\'s date, the location, and the current value ' +
  'of each tracked reading. Write a brief comment (one or two sentences) that ' +
  'draws on these inputs — vary your phrasing across runs; do not repeat the ' +
  'same template. End with a short haiku (three lines, 5-7-5 syllables) that ' +
  'weaves in the readings and the day\'s vibe. ' +
  'Reply with the message text only — no quotes, no preamble, no markdown.';

function buildUserPrompt(ctx: LoopContext): string {
  const lines = [
    `Date: ${ctx.date}`,
    `Location: ${ctx.location}`,
    ...ctx.readings.map((r) => `${r.source}: ${r.value}`),
  ];
  return lines.join('\n');
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
  async function attempt(ctx: LoopContext): Promise<string> {
    const response = await options.client.send(
      new ConverseCommand({
        modelId: composedModelId(options.modelId),
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: buildUserPrompt(ctx) }] }],
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
    async format(ctx: LoopContext): Promise<string> {
      try {
        return await attempt(ctx);
      } catch (error: unknown) {
        if (isThrottlingOr5xx(error)) {
          await delay(RETRY_DELAY_MS);
          try {
            return await attempt(ctx);
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
