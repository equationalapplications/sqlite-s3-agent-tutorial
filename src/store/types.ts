/**
 * The abstraction the writer and reader use for the snapshot blob. `S3Store` (PR2) and
 * `LocalStore` implement the same interface so the agent's orchestration code never
 * branches on which backend is active.
 *
 * `ifMatch: string | null` — `null` means "this is a bootstrap put; there is no prior
 * version to match against." S3's HTTP `If-Match` semantics are translated by the S3
 * implementation and never leak into caller code (spec §4.2).
 */
export interface Store {
  /** Returns `{ etag }` for `key`, or `null` if it does not exist. */
  head(key: string): Promise<{ etag: string } | null>;
  /** Returns `{ etag, body }` for `key`, or `null` if it does not exist. */
  get(key: string): Promise<{ etag: string; body: Buffer } | null>;
  /**
   * Writes `body` to `key`. `ifMatch: null` performs a bootstrap put (no precondition on
   * the wire); a non-null value performs a conditional put.
   *
   * @throws {PreconditionFailedError} when `ifMatch` does not match the object's current
   *   etag (or the object does not exist and `ifMatch` was non-null).
   */
  put(key: string, body: Buffer, ifMatch: string | null): Promise<{ etag: string }>;
}

/** Thrown by `Store.put` on a conditional-write conflict. Do not retry (spec §4.2). */
export class PreconditionFailedError extends Error {
  constructor() {
    super(
      'PreconditionFailed: Store conditional write failed — another writer committed ' +
        'first, or the object does not exist. Do not retry — a blind retry would re-fetch ' +
        'and re-post against a stale base.',
    );
    this.name = 'PreconditionFailedError';
  }
}
