/** Thrown by `DiscordPoster.post` on a non-2xx response after any retry has been exhausted. */
export class DiscordPostError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Discord webhook responded ${status}: ${body}`);
    this.name = 'DiscordPostError';
    this.status = status;
  }
}

/** Posts a formatted message to a Discord webhook. */
export interface DiscordPoster {
  post(message: string): Promise<void>;
}

const RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real `DiscordPoster`, backed by `fetch`.
 *
 * 4xx: no retry (spec §6) — the request is malformed or the webhook is invalid, and a
 * retry cannot fix that. 5xx: one retry with a fixed ~250ms backoff, then give up — the
 * writer skips this source's notification for the run and the next run tries again.
 */
export function createFetchDiscordPoster(
  webhookUrl: string,
  fetchImpl: typeof fetch = fetch,
): DiscordPoster {
  async function attempt(message: string): Promise<Response> {
    return fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  }

  return {
    async post(message: string): Promise<void> {
      let response = await attempt(message);

      if (!response.ok && response.status >= 500) {
        await delay(RETRY_DELAY_MS);
        response = await attempt(message);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new DiscordPostError(response.status, body);
      }
    },
  };
}
