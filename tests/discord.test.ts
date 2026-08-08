// tests/discord.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createFetchDiscordPoster, DiscordPostError } from '../src/discord/poster.js';

describe('createFetchDiscordPoster', () => {
  it('posts the message as JSON content to the webhook URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return new Response(null, { status: 204 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await poster.post('hello world');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://discord.example/webhook');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ content: 'hello world' });
  });

  it('throws DiscordPostError on a 4xx response, no retry', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response('bad request', { status: 400 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await expect(poster.post('hello')).rejects.toThrow(DiscordPostError);
    expect(callCount).toBe(1);
  });

  it('retries once on a 5xx response, then throws if still failing', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response('server error', { status: 503 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await expect(poster.post('hello')).rejects.toThrow(DiscordPostError);
    expect(callCount).toBe(2);
  });

  it('succeeds if the retry after a 5xx returns 2xx', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(null, { status: callCount === 1 ? 503 : 204 });
    };

    const poster = createFetchDiscordPoster('https://discord.example/webhook', fakeFetch);
    await expect(poster.post('hello')).resolves.toBeUndefined();
    expect(callCount).toBe(2);
  });
});
