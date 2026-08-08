import type { SourceName } from '../db/schema.js';

export type { SourceName };

/** Fetches one source's current raw value (e.g. `"72F"`, `"67234.10"`). Implementations
 *  hit an external HTTPS API (production) or return canned values (tests). */
export interface SourceFetcher {
  readonly name: SourceName;
  fetch(): Promise<string>;
}
