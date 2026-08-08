import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PreconditionFailedError, type Store } from './types.js';

function etagOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** `Store` backed by a directory on disk. Mirrors S3's `If-Match` semantics locally so
 *  Phase 1 and Phase 2 exercise the same conditional-write contract (spec §9, Phase 2). */
export function createLocalStore(dir: string): Store {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  function pathFor(key: string): string {
    const path = resolve(join(root, key));
    if (path !== root && !path.startsWith(rootWithSep)) {
      throw new Error(`LocalStore: key ${JSON.stringify(key)} escapes store directory`);
    }
    return path;
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

      // Atomic write: stage to a sibling temp file in the same directory, then rename.
      // POSIX rename is atomic within a filesystem, so a crash mid-write leaves the
      // previous snapshot intact (or the new one fully present) — never a truncated
      // file. Mirrors S3's server-side atomicity for parity between phases.
      const tmpPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        writeFileSync(tmpPath, body);
        renameSync(tmpPath, path);
      } catch (error: unknown) {
        // Best-effort cleanup so temp files don't accumulate if rename fails.
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore — leave the temp file visible for postmortem if it can't be removed
        }
        throw error;
      }
      return { etag: etagOf(body) };
    },
  };
}
