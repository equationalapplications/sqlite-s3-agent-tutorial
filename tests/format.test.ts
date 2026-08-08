// tests/format.test.ts
import { describe, expect, it } from 'vitest';
import { createLocalTemplateFormatter } from '../src/format/local.js';

describe('LocalTemplateFormatter', () => {
  it('formats a weather value deterministically', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format('weather', '72F');
    expect(message).toBe('Weather update: 72F');
  });

  it('formats a crypto value deterministically', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format('crypto', '67234.10');
    expect(message).toBe('Crypto update: 67234.10');
  });

  it('produces the same output for the same input across calls', async () => {
    const formatter = createLocalTemplateFormatter();
    const first = await formatter.format('weather', '72F');
    const second = await formatter.format('weather', '72F');
    expect(first).toBe(second);
  });
});