import type { SourceFetcher } from './types.js';

/** Fetches the current temperature for a fixed location from wttr.in's plain-text format.
 *  Key-free public endpoint, chosen for the tutorial demo (spec §11). */
export function createWeatherFetcher(location = 'NYC'): SourceFetcher {
  return {
    name: 'weather',
    async fetch() {
      const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=%t`);
      if (!response.ok) {
        throw new Error(`wttr.in responded ${response.status}`);
      }
      const text = await response.text();
      return text.trim();
    },
  };
}
