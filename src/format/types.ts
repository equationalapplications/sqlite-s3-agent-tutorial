import type { SourceName } from '../db/schema.js';

export type { SourceName };

/** One entry per source that fetched successfully this tick — source-agnostic, so a
 *  third source added per `docs/04-extending.md` shows up in the prompt automatically
 *  (loop-mode + poetic-closing spec §4.2). A failed source is absent from the array
 *  rather than represented as `'<unavailable>'` — the LLM sees only sources it has
 *  real data for. */
export interface LoopReading {
  source: SourceName;
  value: string;
}

/** The full set of inputs the formatter sees per tick. `date` and `location` are simple
 *  ambient context; `readings` carries the structured data the LLM should weave into
 *  its friendly comment and closing haiku. RAG is intentionally *not* in this shape:
 *  the LLM is not told about the closest past reading. The "Reminds me of" suffix is
 *  appended mechanically in the writer after the format call returns. */
export interface LoopContext {
  date: string;            // ISO date, e.g. "2026-08-09"
  location: string;        // e.g. "NYC"
  readings: LoopReading[]; // one entry per source that succeeded this tick
}

/** Turns a `LoopContext` into a friendly Discord message. `LocalTemplateFormatter` and
 *  `BedrockFormatter` implement the same interface, so the writer's hot path does not
 *  change between local and deployed. The LLM is given `date`, `location`, and
 *  `readings`; the writer mechanically appends the "Reminds me of" suffix to the
 *  formatter's output after the RAG lookup, so the formatter never sees the closest
 *  past reading. */
export interface MessageFormatter {
  format(ctx: LoopContext): Promise<string>;
}
