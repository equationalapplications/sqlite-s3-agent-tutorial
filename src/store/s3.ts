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
        return { etag: response.ETag ?? '' };
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
        return { etag: response.ETag ?? '', body: Buffer.from(body) };
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
        return { etag: response.ETag ?? '' };
      } catch (error: unknown) {
        // S3 returns PreconditionFailed for an etag mismatch on a conditional update
        // and NoSuchKey when a conditional update targets a missing object. Both map
        // to the same domain error: the precondition did not hold.
        if (isPreconditionFailed(error) || isNoSuchKey(error)) {
          throw new PreconditionFailedError();
        }
        throw error;
      }
    },
  };
}
