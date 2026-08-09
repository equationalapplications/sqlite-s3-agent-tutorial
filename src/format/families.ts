/**
 * Which inference-profile prefixes a Bedrock model family accepts (spec §12.3). Verified
 * against Bedrock, never inferred from a model's name. Adding a new family requires a
 * live probe of accepted prefixes and request shape, including a mandatory negative
 * control — some families accept unknown request fields silently, so "the request did
 * not 400" is not evidence a field is supported.
 */
export interface ModelFamily {
  readonly id: string;
  readonly matchesModelId: (baseModelId: string) => boolean;
  /** Accepted inference-profile prefixes, default first. Empty string means bare id. */
  readonly prefixes: readonly string[];
}

const KNOWN_PREFIXES = ['global.', 'us.'] as const;

export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze([
  Object.freeze({
    id: 'zai',
    // ON_DEMAND inference type — bare id only, no global./us. inference profile.
    matchesModelId: (id: string) => id.startsWith('zai.'),
    prefixes: Object.freeze(['']),
  }),
  Object.freeze({
    id: 'amazon-nova',
    // global. is an invalid identifier for Nova.
    matchesModelId: (id: string) => id.startsWith('amazon.nova-'),
    prefixes: Object.freeze(['', 'us.']),
  }),
  Object.freeze({
    id: 'anthropic-claude',
    // global. is the default; us. is valid for US-only routing.
    matchesModelId: (id: string) => id.startsWith('anthropic.claude-'),
    prefixes: Object.freeze(['global.', 'us.']),
  }),
]);

/**
 * Derives a model's family from its base id. Throws rather than guessing: an unmatched id
 * is a startup error (spec §11 "an unknown id fails startup, not first invoke"), and a
 * prefix already present on the configured id is rejected because the prefix is supplied
 * by the family, not the user (spec §12.3).
 */
export function resolveFamily(baseModelId: string): ModelFamily {
  const carriedPrefix = KNOWN_PREFIXES.find((p) => baseModelId.startsWith(p));
  if (carriedPrefix !== undefined) {
    throw new Error(
      `Model id "${baseModelId}" already carries the inference-profile prefix ` +
        `"${carriedPrefix}". Configure the base id only; the prefix is supplied by the ` +
        `model's family.`,
    );
  }

  const family = MODEL_FAMILIES.find((candidate) => candidate.matchesModelId(baseModelId));
  if (family === undefined) {
    throw new Error(
      `Model id "${baseModelId}" matches no known model family. Known families: ` +
        `${MODEL_FAMILIES.map((f) => f.id).join(', ')}. Add one only after a live probe ` +
        `against Bedrock with a negative control.`,
    );
  }
  return family;
}
