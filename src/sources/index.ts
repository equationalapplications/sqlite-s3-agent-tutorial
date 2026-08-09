import type { SourceName } from '../db/schema.js';
import { createCryptoFetcher } from './crypto.js';
import type { SourceFetcher } from './types.js';
import { createWeatherFetcher } from './weather.js';

/** Registry: source name -> real SourceFetcher. Extend by adding a case here and to
 *  `SOURCE_NAMES`/the schema CHECK constraint (spec §5, §11: "readers extend it by
 *  editing one CHECK constraint and one fetch function"). */
export function createSourceFetcher(name: SourceName, weatherLocation: string): SourceFetcher {
  switch (name) {
    case 'weather':
      return createWeatherFetcher(weatherLocation);
    case 'crypto':
      return createCryptoFetcher();
  }
}
