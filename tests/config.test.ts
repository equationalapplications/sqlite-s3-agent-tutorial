// tests/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws when discordWebhookUrl is missing', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_WEBHOOK_URL/);
  });

  it('applies defaults for dbPath and sources', () => {
    const config = loadConfig({ DISCORD_WEBHOOK_URL: 'https://discord.example/webhook' });
    expect(config.dbPath).toBe('/tmp/memory.db');
    expect(config.sources).toEqual(['weather', 'crypto']);
    expect(config.discordWebhookUrl).toBe('https://discord.example/webhook');
  });

  it('parses a custom SOURCES env var', () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      SOURCES: '["weather"]',
    });
    expect(config.sources).toEqual(['weather']);
  });

  it('rejects a source outside the closed vocabulary', () => {
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        SOURCES: '["wether"]',
      }),
    ).toThrow(/wether/);
  });

  it('rejects malformed SOURCES JSON', () => {
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
        SOURCES: 'not json',
      }),
    ).toThrow(/SOURCES/);
  });
});
