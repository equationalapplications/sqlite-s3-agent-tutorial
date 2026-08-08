import type Database from 'better-sqlite3';

export interface StartRunParams {
  runId: string;
  op: 'fetch' | 'status';
  snapshotVersionIn: string;
  startedAt: number;
}

export interface FinishRunParams {
  runId: string;
  endedAt: number;
  outcome: 'success' | 'error';
  sourcesChecked: number;
  notificationsSent: number;
  /** Per-source failures joined with `; ` (spec §6), or `null` when nothing failed. */
  error: string | null;
}

/** Inserts the `agent_runs` row at the start of a run (spec §3.1 step 4). */
export function startRun(db: Database.Database, params: StartRunParams): void {
  db.prepare(
    `INSERT INTO agent_runs (run_id, op, snapshot_version_in, started_at)
     VALUES (@runId, @op, @snapshotVersionIn, @startedAt)`,
  ).run(params);
}

/** Updates the `agent_runs` row at the end of a run (spec §3.1 step 6). A row inserted by
 *  `startRun` and never finished (crash mid-run) stays `ended_at IS NULL` — that is itself
 *  a signal, not a defaulted-away failure (spec §5). */
export function finishRun(db: Database.Database, params: FinishRunParams): void {
  db.prepare(
    `UPDATE agent_runs
     SET ended_at = @endedAt, outcome = @outcome, sources_checked = @sourcesChecked,
         notifications_sent = @notificationsSent, error = @error
     WHERE run_id = @runId`,
  ).run(params);
}
