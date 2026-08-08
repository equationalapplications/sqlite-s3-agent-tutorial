/**
 * The abstraction the writer and reader use for the snapshot blob. `S3Store` (PR2) and
 * `LocalStore` implement the same interface so the agent's orchestration code never
 * branches on which backend is active.
 *
 * `ifMatch: string | null` — `null` is reserved for the bootstrap branch: the writer's
 * very first invocation, when the store has no object to match against (spec §4.1). A
 * bootstrap put succeeds only if the key does not already exist; if it does, the store
 * throws `PreconditionFailedError` (the bootstrap path has been re-entered, which is a
 * programming error, not a race).
 *
 * A non-null `ifMatch` is a conditional put against the prior etag; the S3
 * implementation translates it into the HTTP `If-Match` header, and the LocalStore
 * mirrors the same semantics against a file on disk. Both reject with
 * `PreconditionFailedError` when the etag doesn't match the current value (or when the
 * key doesn't exist) — a blind retry would re-fetch and re-post against a stale base
 * (spec §4.2).
 */
export interface Store {
  /** Returns `{ etag }` for `key`, or `null` if it does not exist. */
  head(key: string): Promise<{ etag: string } | null>;
  /** Returns `{ etag, body }` for `key`, or `null` if it does not exist. */
  get(key: string): Promise<{ etag: string; body: Buffer } | null>;
  /**
   * Writes `body` to `key`.
   * - `ifMatch: null` — bootstrap put. Succeeds only if the key does not exist.
   * - `ifMatch: <etag>` — conditional put. Succeeds only if the current etag matches.
   *
   * @throws {PreconditionFailedError} when the precondition fails (key already exists on
   *   a bootstrap put, key missing on a conditional put, or etag mismatch).
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
