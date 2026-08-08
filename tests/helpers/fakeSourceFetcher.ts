import type { SourceFetcher, SourceName } from '../../src/sources/types.js';

/** Canned-value `SourceFetcher` for tests. Throws if `fetch()` is called more times than
 *  `values` has entries — a test asserting an exact call count catches over-fetching. */
export function fakeSourceFetcher(name: SourceName, values: string[]): SourceFetcher {
  let index = 0;
  return {
    name,
    async fetch() {
      if (index >= values.length) {
        throw new Error(`fakeSourceFetcher(${name}): no more canned values (called ${index + 1} times)`);
      }
      return values[index++] as string;
    },
  };
}

/** A `SourceFetcher` whose `fetch()` always throws, for partial-failure tests. */
export function throwingSourceFetcher(name: SourceName, message: string): SourceFetcher {
  return {
    name,
    async fetch() {
      throw new Error(message);
    },
  };
}
