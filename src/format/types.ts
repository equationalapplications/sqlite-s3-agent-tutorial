import type { SourceName } from '../db/schema.js';

/** Turns a raw fetched value into a friendly Discord message. `LocalTemplateFormatter`
 *  (this PR) and `BedrockFormatter` (PR2) implement the same interface, so the writer's
 *  hot path does not change between local and deployed (spec §2). */
export interface MessageFormatter {
  format(source: SourceName, rawValue: string): Promise<string>;
}