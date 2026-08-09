import { type BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface TitanEmbedderOptions {
  client: BedrockRuntimeClient;
  region: string;
}

/** Fixed — unlike the chat model (`bedrockModelId`, `src/format/families.ts`), the
 *  embedding model isn't configurable (RAG design spec §4.1): one model, one code path,
 *  no family-resolution branching. Changing it would mean re-embedding the whole corpus,
 *  a migration problem this tutorial doesn't need to teach. */
const MODEL_ID = 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 256;
const RETRY_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottlingOr5xx(error: unknown): boolean {
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name;
  return name === 'ThrottlingException' || name === 'InternalServerException' || name === 'ServiceUnavailableException';
}

/** Maps a Bedrock exception to a message naming the fix, mirroring
 *  `src/format/bedrock.ts`'s `mapBedrockError`. */
function mapTitanError(error: unknown, region: string): Error {
  const where = `model "${MODEL_ID}", region ${region}`;
  const name = error instanceof Error ? error.name : (error as { name?: string })?.name ?? 'UnknownError';
  const detail = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);

  switch (name) {
    case 'AccessDeniedException':
      return new Error(
        `Bedrock model access is not granted for ${where}. Enable the model in the ` +
          `Bedrock console's Model access page for this account and region. ` +
          `Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ValidationException':
      return new Error(
        `Bedrock rejected the embedding request for ${where}. Underlying error: ${detail}`,
        { cause: error },
      );
    case 'ResourceNotFoundException':
      return new Error(
        `Bedrock does not recognise the model id for ${where}. Underlying error: ${detail}`,
        { cause: error },
      );
    default:
      return new Error(`Bedrock embedding call failed for ${where} with ${name}: ${detail}`, { cause: error });
  }
}

/**
 * `Embedder` backed by Amazon Bedrock's `InvokeModel` API against Titan Text Embeddings
 * V2 (RAG design spec §4.1). Titan's embedding API is `InvokeModel`, not `Converse` —
 * `Converse` is for chat-turn models, which this isn't.
 *
 * One retry on `ThrottlingException`/5xx with a fixed ~500ms backoff, mirroring
 * `src/format/bedrock.ts`; every other exception is not retried.
 */
export function createTitanEmbedder(options: TitanEmbedderOptions): Embedder {
  async function attempt(text: string): Promise<number[]> {
    const response = await options.client.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text, dimensions: DIMENSIONS, normalize: true }),
      }),
    );

    const decoded = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(decoded) as { embedding?: unknown };
    if (
      !Array.isArray(parsed.embedding) ||
      parsed.embedding.length !== DIMENSIONS ||
      !parsed.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new Error(`Titan returned no embedding for model "${MODEL_ID}"`);
    }
    return parsed.embedding as number[];
  }

  return {
    async embed(text: string): Promise<number[]> {
      try {
        return await attempt(text);
      } catch (error: unknown) {
        if (isThrottlingOr5xx(error)) {
          await delay(RETRY_DELAY_MS);
          try {
            return await attempt(text);
          } catch (retryError: unknown) {
            throw mapTitanError(retryError, options.region);
          }
        }
        if (error instanceof Error && error.message.startsWith('Titan returned no embedding')) {
          throw error; // malformed response — not retried, message is already descriptive
        }
        throw mapTitanError(error, options.region);
      }
    },
  };
}
