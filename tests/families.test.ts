import { describe, expect, it } from 'vitest';
import { resolveFamily } from '../src/format/families.js';

describe('resolveFamily', () => {
  it('resolves zai.glm-4.7-flash to the zai family with a bare prefix', () => {
    const family = resolveFamily('zai.glm-4.7-flash');
    expect(family.id).toBe('zai');
    expect(family.prefixes).toEqual(['']);
  });

  it('resolves amazon.nova-* to the amazon-nova family', () => {
    const family = resolveFamily('amazon.nova-lite-v1:0');
    expect(family.id).toBe('amazon-nova');
    expect(family.prefixes).toEqual(['', 'us.']);
  });

  it('resolves anthropic.claude-* to the anthropic-claude family', () => {
    const family = resolveFamily('anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(family.id).toBe('anthropic-claude');
    expect(family.prefixes).toEqual(['global.', 'us.']);
  });

  it('throws for an unknown model id', () => {
    expect(() => resolveFamily('made-up.model-1')).toThrow(/no known model family/);
  });

  it('throws when the base id already carries a known prefix', () => {
    expect(() => resolveFamily('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toThrow(
      /already carries/,
    );
  });
});
