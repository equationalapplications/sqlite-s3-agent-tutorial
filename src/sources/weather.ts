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
      // Location folded into the value itself (not a separate field): it's static per
      // deploy, so it never causes a spurious dedup re-post, and the formatter needs no
      // extra plumbing to see it — it's already reading the full rawValue.
      return `${location}: ${text.trim()}`;
    },
  };
}
