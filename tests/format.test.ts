// tests/format.test.ts
import { describe, expect, it } from 'vitest';
import { createLocalTemplateFormatter } from '../src/format/local.js';
import type { LoopContext } from '../src/format/types.js';

const ctx = (
  readings: Array<{ source: 'weather' | 'crypto'; value: string }>,
  date = '2026-08-09',
  location = 'NYC',
): LoopContext => ({
  date,
  location,
  readings,
});

describe('LocalTemplateFormatter', () => {
  it('formats a single weather reading with date and location', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format(ctx([{ source: 'weather', value: '72F' }]));
    expect(message).toBe('2026-08-09 — NYC — weather: 72F');
  });

  it('formats a single crypto reading with date and location', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format(ctx([{ source: 'crypto', value: '67234.10' }]));
    expect(message).toBe('2026-08-09 — NYC — crypto: 67234.10');
  });

  it('joins multiple readings with comma separators', async () => {
    const formatter = createLocalTemplateFormatter();
    const message = await formatter.format(
      ctx([
        { source: 'weather', value: '72F' },
        { source: 'crypto', value: '67234.10' },
      ]),
    );
    expect(message).toBe('2026-08-09 — NYC — weather: 72F, crypto: 67234.10');
  });

  it('produces the same output for the same input across calls', async () => {
    const formatter = createLocalTemplateFormatter();
    const first = await formatter.format(ctx([{ source: 'weather', value: '72F' }]));
    const second = await formatter.format(ctx([{ source: 'weather', value: '72F' }]));
    expect(first).toBe(second);
  });
});
