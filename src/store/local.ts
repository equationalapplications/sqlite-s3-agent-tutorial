import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PreconditionFailedError, type Store } from './types.js';

function etagOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** `Store` backed by a directory on disk. Mirrors S3's `If-Match` semantics locally so
 *  Phase 1 and Phase 2 exercise the same conditional-write contract (spec §9, Phase 2). */
export function createLocalStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });

  function pathFor(key: string): string {
    return join(dir, key);
  }

  return {
    async head(key: string) {
      const path = pathFor(key);
      if (!existsSync(path)) return null;
      return { etag: etagOf(readFileSync(path)) };
    },

    async get(key: string) {
      const path = pathFor(key);
      if (!existsSync(path)) return null;
      const body = readFileSync(path);
      return { etag: etagOf(body), body };
    },

    async put(key: string, body: Buffer, ifMatch: string | null) {
      const path = pathFor(key);
      const exists = existsSync(path);

      if (ifMatch === null) {
        if (exists) {
          throw new PreconditionFailedError();
        }
      } else {
        if (!exists) {
          throw new PreconditionFailedError();
        }
        const current = etagOf(readFileSync(path));
        if (current !== ifMatch) {
          throw new PreconditionFailedError();
        }
      }

      writeFileSync(path, body);
      return { etag: etagOf(body) };
    },
  };
}
