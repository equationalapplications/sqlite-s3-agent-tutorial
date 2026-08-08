import type { MessageFormatter } from './types.js';

const LABELS = { weather: 'Weather update', crypto: 'Crypto update' } as const;

/** Deterministic, no-AWS `MessageFormatter` for Phase 1 (spec §9). Never used in the
 *  deployed Lambda — `BedrockFormatter` (PR2) is the default there. */
export function createLocalTemplateFormatter(): MessageFormatter {
  return {
    async format(source, rawValue) {
      return `${LABELS[source]}: ${rawValue}`;
    },
  };
}