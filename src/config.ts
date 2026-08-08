import { SOURCE_NAMES, type SourceName } from './db/schema.js';

/**
 * Phase 1 subset of the config surface (spec §11). PR2 adds `region`, `snapshotBucket`,
 * `snapshotKey`, and the `bedrock*` fields; this module is the single place any of them
 * will be read from — no other module reads `process.env`.
 */
export interface AgentConfig {
  readonly dbPath: string;
  readonly discordWebhookUrl: string;
  readonly sources: readonly SourceName[];
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function str(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function sources(env: Env): readonly SourceName[] {
  const raw = env.SOURCES;
  if (raw === undefined || raw.trim() === '') {
    return ['weather', 'crypto'];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Environment variable SOURCES must be a JSON array, got: ${raw}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Environment variable SOURCES must be a JSON array, got: ${raw}`);
  }

  for (const entry of parsed) {
    if (typeof entry !== 'string' || !(SOURCE_NAMES as readonly string[]).includes(entry)) {
      throw new Error(
        `Environment variable SOURCES contains an unknown source "${String(entry)}". ` +
          `Known sources: ${SOURCE_NAMES.join(', ')}.`,
      );
    }
  }

  return parsed as SourceName[];
}

export function loadConfig(env: Env = process.env): AgentConfig {
  return Object.freeze({
    dbPath: str(env, 'DB_PATH', '/tmp/memory.db'),
    discordWebhookUrl: required(env, 'DISCORD_WEBHOOK_URL'),
    sources: sources(env),
  });
}
