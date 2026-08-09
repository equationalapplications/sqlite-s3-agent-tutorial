import type { LoopContext, MessageFormatter } from './types.js';

/** Deterministic, no-AWS `MessageFormatter` for local runs (spec §9). Emits a
 *  `"{date} — {location} — {source}: {value}, ..."` shape — one segment per reading
 *  in input order. Source-agnostic: a third source added per `docs/04-extending.md`
 *  shows up in the output automatically. Not expected to generate a haiku — it's a
 *  test-only stub. Never used in the deployed Lambda — `BedrockFormatter` is the
 *  default there (`src/handler.ts`). */
export function createLocalTemplateFormatter(): MessageFormatter {
  return {
    async format(ctx: LoopContext): Promise<string> {
      const segments = ctx.readings.map((r) => `${r.source}: ${r.value}`).join(', ');
      return `${ctx.date} — ${ctx.location} — ${segments}`;
    },
  };
}
