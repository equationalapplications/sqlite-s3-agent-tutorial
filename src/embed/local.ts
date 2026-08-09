import type { Embedder } from './titan.js';

const DIMENSIONS = 256;

/**
 * Deterministic, no-AWS `Embedder` for Phase 1 (mirrors `createLocalTemplateFormatter`
 * in `src/format/local.ts`). Not semantically meaningful — it's a character-code hash,
 * not a real embedding — but identical input text always produces an identical vector
 * (zero cosine distance), and different text produces different vectors, which is
 * enough for `runFetch`'s RAG step (embed, store, KNN-match) to run and be tested without
 * a Bedrock call. Never used in the deployed Lambda — `createTitanEmbedder` is the
 * default there (`src/handler.ts`).
 */
export function createLocalEmbedder(): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const vector = new Array(DIMENSIONS).fill(0) as number[];
      for (let i = 0; i < text.length; i++) {
        const index = i % DIMENSIONS;
        vector[index] = (vector[index] ?? 0) + text.charCodeAt(i);
      }
      return vector;
    },
  };
}
