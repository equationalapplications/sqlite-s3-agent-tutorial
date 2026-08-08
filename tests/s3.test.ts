// tests/s3.test.ts
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createS3Store } from '../src/store/s3.js';
import { PreconditionFailedError } from '../src/store/types.js';

const s3 = mockClient(S3Client);

function s3Body(content: string) {
  return sdkStreamMixin(Readable.from([content]));
}

describe('S3Store', () => {
  beforeEach(() => s3.reset());
  afterEach(() => s3.reset());

  const store = createS3Store({
    client: new S3Client({ region: 'us-east-1' }),
    bucket: 'test-bucket',
  });

  describe('head', () => {
    it('returns the etag when the object exists', async () => {
      s3.on(HeadObjectCommand).resolves({ ETag: '"abc123"' });
      const result = await store.head('memory.db');
      expect(result).toEqual({ etag: '"abc123"' });
    });

    it('returns null on NotFound', async () => {
      s3.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      const result = await store.head('memory.db');
      expect(result).toBeNull();
    });

    it('propagates non-404 errors', async () => {
      s3.on(HeadObjectCommand).rejects(new Error('AccessDenied'));
      await expect(store.head('memory.db')).rejects.toThrow('AccessDenied');
    });
  });

  describe('get', () => {
    it('returns etag and body when the object exists', async () => {
      s3.on(GetObjectCommand).resolves({ ETag: '"abc123"', Body: s3Body('sqlite content') });
      const result = await store.get('memory.db');
      expect(result?.etag).toBe('"abc123"');
      expect(result?.body.toString()).toBe('sqlite content');
    });

    it('returns null on NoSuchKey (bootstrap case)', async () => {
      s3.on(GetObjectCommand).rejects({ name: 'NoSuchKey' });
      const result = await store.get('memory.db');
      expect(result).toBeNull();
    });

    it('propagates non-404 errors', async () => {
      s3.on(GetObjectCommand).rejects(new Error('AccessDenied'));
      await expect(store.get('memory.db')).rejects.toThrow('AccessDenied');
    });
  });

  describe('put', () => {
    it('sends If-Match when ifMatch is non-null', async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"def456"' });
      const result = await store.put('memory.db', Buffer.from('data'), '"abc123"');

      expect(result.etag).toBe('"def456"');
      const calls = s3.commandCalls(PutObjectCommand);
      expect(calls[0]?.args[0].input?.IfMatch).toBe('"abc123"');
    });

    it('sends IfNoneMatch: "*" when ifMatch is null (bootstrap put)', async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
      await store.put('memory.db', Buffer.from('data'), null);

      const calls = s3.commandCalls(PutObjectCommand);
      expect(calls[0]?.args[0].input?.IfMatch).toBeUndefined();
      expect(calls[0]?.args[0].input?.IfNoneMatch).toBe('*');
    });

    it('throws PreconditionFailedError on 412', async () => {
      s3.on(PutObjectCommand).rejects({ name: 'PreconditionFailed' });
      await expect(
        store.put('memory.db', Buffer.from('data'), '"abc123"'),
      ).rejects.toThrow(PreconditionFailedError);
    });

    it('throws PreconditionFailedError on NoSuchKey for a conditional update', async () => {
      // S3 returns NoSuchKey when a conditional update targets a missing object — the
      // precondition cannot hold against something that doesn't exist. Same domain
      // error as a 412: the object is not in the state the writer expected.
      s3.on(PutObjectCommand).rejects({ name: 'NoSuchKey' });
      await expect(
        store.put('memory.db', Buffer.from('data'), '"abc123"'),
      ).rejects.toThrow(PreconditionFailedError);
    });

    it('propagates non-412 errors', async () => {
      s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));
      await expect(
        store.put('memory.db', Buffer.from('data'), '"abc123"'),
      ).rejects.toThrow('AccessDenied');
    });

    it('throws when the response has no ETag', async () => {
      s3.on(PutObjectCommand).resolves({});
      await expect(
        store.put('memory.db', Buffer.from('data'), '"abc123"'),
      ).rejects.toThrow(/no ETag/);
    });
  });
});
