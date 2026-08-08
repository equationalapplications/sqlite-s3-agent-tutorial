import type { SourceFetcher } from './types.js';

/** Fetches the current USD price of Bitcoin from CoinGecko's simple price endpoint.
 *  Key-free public endpoint, chosen for the tutorial demo (spec §11). */
export function createCryptoFetcher(): SourceFetcher {
  return {
    name: 'crypto',
    async fetch() {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      );
      if (!response.ok) {
        throw new Error(`coingecko responded ${response.status}`);
      }
      const json = (await response.json()) as { bitcoin?: { usd?: number } };
      const price = json.bitcoin?.usd;
      if (price === undefined) {
        throw new Error('coingecko response missing bitcoin.usd');
      }
      return String(price);
    },
  };
}
