// tests/store.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalStore } from '../src/store/local.js';

describe('LocalStore', () => {
  it('head and get return null when the key does not exist (bootstrap case)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    expect(await store.head('memory.db')).toBeNull();
    expect(await store.get('memory.db')).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  it('put with ifMatch: null succeeds on first write and returns an etag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    const result = await store.put('memory.db', Buffer.from('hello'), null);
    expect(result.etag).toBeTruthy();

    const got = await store.get('memory.db');
    expect(got?.body.toString()).toBe('hello');
    expect(got?.etag).toBe(result.etag);

    rmSync(dir, { recursive: true, force: true });
  });

  it('put with a matching ifMatch succeeds and changes the etag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    const first = await store.put('memory.db', Buffer.from('v1'), null);
    const second = await store.put('memory.db', Buffer.from('v2'), first.etag);

    expect(second.etag).not.toBe(first.etag);
    const got = await store.get('memory.db');
    expect(got?.body.toString()).toBe('v2');

    rmSync(dir, { recursive: true, force: true });
  });

  it('put with a stale ifMatch throws PreconditionFailedError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
    const store = createLocalStore(dir);

    await store.put('memory.db', Buffer.from('v1'), null);
    // Someone else writes in between.
    await store.put('memory.db', Buffer.from('v2'), (await store.head('memory.db'))?.etag ?? null);

    await expect(
      store.put('memory.db', Buffer.from('v3'), 'stale-etag'),
    ).rejects.toThrow(/PreconditionFailed/);

    rmSync(dir, { recursive: true, force: true });
  });
});
