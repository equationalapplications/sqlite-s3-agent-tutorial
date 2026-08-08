// tests/runLog.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/db/bootstrap.js';
import { openDatabase } from '../src/db/open.js';
import { finishRun, startRun } from '../src/agent/runLog.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runlog-test-'));
  const db = openDatabase(join(dir, 'memory.db'));
  bootstrap(db);
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('startRun / finishRun', () => {
  it('inserts a run row with no ended_at or outcome', () => {
    const { db, cleanup } = freshDb();

    startRun(db, { runId: 'r1', op: 'fetch', snapshotVersionIn: 'none', startedAt: 1000 });

    const row = db.prepare(`SELECT * FROM agent_runs WHERE run_id = 'r1'`).get() as Record<string, unknown>;
    expect(row.op).toBe('fetch');
    expect(row.snapshot_version_in).toBe('none');
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBeNull();
    expect(row.outcome).toBeNull();

    db.close();
    cleanup();
  });

  it('finishRun updates the same row with ended_at, outcome, and counts', () => {
    const { db, cleanup } = freshDb();

    startRun(db, { runId: 'r1', op: 'fetch', snapshotVersionIn: 'none', startedAt: 1000 });
    finishRun(db, {
      runId: 'r1',
      endedAt: 2000,
      outcome: 'success',
      sourcesChecked: 2,
      notificationsSent: 1,
      error: null,
    });

    const row = db.prepare(`SELECT * FROM agent_runs WHERE run_id = 'r1'`).get() as Record<string, unknown>;
    expect(row.ended_at).toBe(2000);
    expect(row.outcome).toBe('success');
    expect(row.sources_checked).toBe(2);
    expect(row.notifications_sent).toBe(1);
    expect(row.error).toBeNull();

    db.close();
    cleanup();
  });

  it('finishRun records a non-null error string when a source failed', () => {
    const { db, cleanup } = freshDb();

    startRun(db, { runId: 'r1', op: 'fetch', snapshotVersionIn: 'none', startedAt: 1000 });
    finishRun(db, {
      runId: 'r1',
      endedAt: 2000,
      outcome: 'success',
      sourcesChecked: 2,
      notificationsSent: 1,
      error: 'weather: fetch timeout',
    });

    const row = db.prepare(`SELECT error FROM agent_runs WHERE run_id = 'r1'`).get() as { error: string };
    expect(row.error).toBe('weather: fetch timeout');

    db.close();
    cleanup();
  });
});
