import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { PreconditionFailedError, type Store } from './types.js';

export interface S3StoreOptions {
  client: S3Client;
  bucket: string;
}

function isNoSuchKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'NoSuchKey';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'NotFound';
}

function isPreconditionFailed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'PreconditionFailed'
  );
}

function isConditionalRequestConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'ConditionalRequestConflict'
  );
}

/**
 * Extracts an ETag from an S3 response, failing fast when missing or empty. The Store
 * contract depends on every etag being usable as the next `ifMatch` value; a missing
 * or empty etag would silently produce `If-Match: ""`, which surfaces as a confusing
 * 412 from the next call. Better to throw at the read site than poison downstream.
 */
function requireEtag(op: string, key: string, etag: string | undefined): string {
  if (etag === undefined || etag === '') {
    throw new Error(`S3 ${op} for ${key} returned no ETag; Store contract requires one`);
  }
  return etag;
}

/**
 * `Store` backed by S3 (spec §4.2). The `ifMatch: string | null` contract is translated
 * to S3's wire semantics here and nowhere else: `null` sends `IfNoneMatch: '*'`, a
 * conditional create that fails if the key already exists; a non-null value sends
 * `IfMatch: <etag>`, a conditional update that fails if the current etag doesn't match.
 * Both branches are conditional — we never issue an unconditional overwrite. Callers
 * never see this translation.
 */
export function createS3Store(options: S3StoreOptions): Store {
  return {
    async head(key: string) {
      try {
        const response = await options.client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        return { etag: requireEtag('HeadObject', key, response.ETag) };
      } catch (error: unknown) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async get(key: string) {
      try {
        const response = await options.client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        const body = await response.Body?.transformToByteArray();
        if (body === undefined) {
          throw new Error(`S3 object ${key} has no body`);
        }
        return { etag: requireEtag('GetObject', key, response.ETag), body: Buffer.from(body) };
      } catch (error: unknown) {
        if (isNoSuchKey(error)) return null;
        throw error;
      }
    },

    async put(key: string, body: Buffer, ifMatch: string | null) {
      try {
        const response = await options.client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: body,
            ContentType: 'application/vnd.sqlite3',
            ...(ifMatch === null ? { IfNoneMatch: '*' } : { IfMatch: ifMatch }),
          }),
        );
        return { etag: requireEtag('PutObject', key, response.ETag) };
      } catch (error: unknown) {
        // S3 returns three distinct errors when a conditional write cannot land:
        //   PreconditionFailed (412)        — etag mismatch on a conditional update
        //   NoSuchKey (404)                  — conditional update targets a missing object
        //   ConditionalRequestConflict (409) — a concurrent operation raced the write
        // (e.g. a delete arriving mid-put). All three mean "the precondition did not hold,
        // and the previous snapshot stays authoritative" — per spec §6 the writer must
        // abort loudly and never retry. reservedConcurrency: 1 makes a real race
        // impossible, so any of these surfacing is a misconfiguration or out-of-band
        // write; the right response is the same in all three cases.
        if (isPreconditionFailed(error) || isNoSuchKey(error) || isConditionalRequestConflict(error)) {
          throw new PreconditionFailedError();
        }
        throw error;
      }
    },
  };
}
