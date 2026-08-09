import type { SourceName } from '../db/schema.js';

export type { SourceName };

/** The minimal shape `format()` needs from a RAG nearest-match lookup (see
 *  `src/rag/similarity.ts`'s richer `NearestMatch`) — kept separate so `format/` doesn't
 *  import from `rag/`; a `NearestMatch` is structurally assignable here since it has
 *  every field `SimilarPastResult` needs and more. */
export interface SimilarPastResult {
  formattedMessage: string;
  postedAt: number;
}

/** Turns a raw fetched value into a friendly Discord message. `LocalTemplateFormatter`
 *  (this PR) and `BedrockFormatter` (PR2) implement the same interface, so the writer's
 *  hot path does not change between local and deployed (spec §2). `similarPast`, when
 *  provided, is the closest same-source past notification (RAG design spec §4.3) —
 *  `null`/omitted means no history exists yet or the RAG lookup failed and was isolated. */
export interface MessageFormatter {
  format(source: SourceName, rawValue: string, similarPast?: SimilarPastResult | null): Promise<string>;
}
