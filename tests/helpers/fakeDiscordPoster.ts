import type { DiscordPoster } from '../../src/discord/poster.js';

export interface RecordingDiscordPoster extends DiscordPoster {
  readonly posted: string[];
}

/** In-memory `DiscordPoster` for tests — records every posted message instead of making
 *  a network call (spec §7.1). */
export function fakeDiscordPoster(): RecordingDiscordPoster {
  const posted: string[] = [];
  return {
    posted,
    async post(message: string) {
      posted.push(message);
    },
  };
}
