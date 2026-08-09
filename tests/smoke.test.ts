// tests/smoke.test.ts
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ESM has no `__dirname`; reconstruct one from `import.meta.url` so the smoke
// test can locate scripts/smoke.sh regardless of where vitest is invoked from.
const THIS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '..');
const SMOKE_SCRIPT = join(REPO_ROOT, 'scripts', 'smoke.sh');

interface ShimEnv {
  dir: string;
  binDir: string;
  originalPath: string;
  originalCwd: string;
  logPath: string;
}

function setupShims(): ShimEnv {
  const dir = mkdtempSync(join(tmpdir(), 'agent-smoke-shim-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(dir, 'invocations.log');
  writeFileSync(logPath, '');

  // Each shim is a thin bash wrapper that records its argv to a shared log file
  // and then delegates to a per-scenario behavior fragment. Args are JSON-encoded
  // via jq -Rsa so spaces, newlines, and JSON round-trip cleanly. The behavior
  // file is identified by the shim name from the dispatch wrapper.
  const shimBody = (name: string) => `#!/usr/bin/env bash
set -e
echo "\$(date +%s%N) ${name} \$(printf '%s' "\$*" | jq -Rsa .)" >> '${logPath}'
if [ -n "\${SHIM_BEHAVIOR_FILE_DIR:-}" ] && [ -d "\${SHIM_BEHAVIOR_FILE_DIR}" ]; then
  behavior="\${SHIM_BEHAVIOR_FILE_DIR}/${name}.sh"
  if [ -f "\$behavior" ]; then
    bash "\$behavior" "\$@"
    exit \$?
  fi
fi
echo "FAIL: shim ${name} invoked without SHIM_BEHAVIOR_FILE" >&2
exit 99
`;

  for (const name of ['aws', 'curl', 'sleep']) {
    const path = join(binDir, name);
    writeFileSync(path, shimBody(name));
    chmodSync(path, 0o755);
  }

  return {
    dir,
    binDir,
    originalPath: process.env.PATH ?? '',
    originalCwd: process.cwd(),
    logPath,
  };
}

function runSmoke(
  env: ShimEnv,
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync('bash', [SMOKE_SCRIPT], {
    env: {
      ...process.env,
      // Put the shim binDir FIRST so the mocked `aws`/`curl`/`sleep` win over
      // the real binaries; keep the rest of PATH so bash, jq, mktemp, etc. are
      // still findable.
      PATH: `${env.binDir}:${env.originalPath}`,
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'default',
      SHIM_BEHAVIOR_FILE_DIR: env.dir,
      ...extraEnv,
    },
    cwd: env.originalCwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

function parseInvocations(env: ShimEnv): Array<{ name: string; args: string }> {
  const text = readFileSync(env.logPath, 'utf8').trim();
  if (text === '') return [];
  return text.split('\n').map((line) => {
    const firstSpace = line.indexOf(' ');
    const secondSpace = line.indexOf(' ', firstSpace + 1);
    const name = line.slice(firstSpace + 1, secondSpace);
    const argsJson = line.slice(secondSpace + 1);
    return { name, args: JSON.parse(argsJson) as string };
  });
}

/** A shim behavior fragment: it scans argv for `-o <path>` (curl -o semantics),
 *  then writes the supplied body to that path and the supplied status code to
 *  stdout. Used by the curl shim to mimic `curl -o <file> -w '%{http_code}'`.
 */
const CURL_BODY_AND_STATUS = `outfile=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$a"; fi
  prev="$a"
done
write_body_and_code() {
  local body="$1" code="$2"
  if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; fi
  printf '%s' "$code"
}
`;

const STACK_DESCRIBE_OK = `if [ "\${1}" = "cloudformation" ] && [ "\${2}" = "describe-stacks" ]; then
  echo '[{"OutputKey":"AgentFunctionUrl","OutputValue":"https://abc.lambda-url.us-east-1.on.aws/"}]'
  exit 0
fi
if [ "\${1}" = "configure" ] && [ "\${2}" = "export-credentials" ]; then
  echo '{"AccessKeyId":"AKIAEXAMPLE","SecretAccessKey":"secretexample"}'
  exit 0
fi
echo "unexpected aws call: \$*" >&2
exit 1
`;

const SLEEP_OK = `exit 0`;

describe('scripts/smoke.sh — read-only status probe', () => {
  let env: ShimEnv;

  beforeAll(() => {
    // Surface a script syntax error immediately so it never masquerades as a
    // harness failure on a real run.
    const syntax = spawnSync('bash', ['-n', SMOKE_SCRIPT], { encoding: 'utf8' });
    if (syntax.status !== 0) {
      throw new Error(`bash -n scripts/smoke.sh failed:\n${syntax.stderr}`);
    }
  });

  beforeEach(() => {
    env = setupShims();
  });

  afterEach(() => {
    if (env) {
      process.env.PATH = env.originalPath;
      process.chdir(env.originalCwd);
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  function setCurlBehavior(fragment: string): void {
    writeFileSync(join(env.dir, 'curl.sh'), CURL_BODY_AND_STATUS + fragment);
  }
  function setAwsBehavior(fragment: string): void {
    writeFileSync(join(env.dir, 'aws.sh'), fragment);
  }
  function setSleepBehavior(fragment: string): void {
    writeFileSync(join(env.dir, 'sleep.sh'), fragment);
  }

  it('unsigned probe returns 403; signed probe returns 200 with empty-state body; exit 0', () => {
    setAwsBehavior(STACK_DESCRIBE_OK);
    setCurlBehavior(`
if [[ " $* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '{"snapshotVersion":null,"sources":[],"recentNotifications":[]}' '200'
else
  write_body_and_code '' '403'
fi
exit 0
`);
    setSleepBehavior(SLEEP_OK);

    const result = runSmoke(env);

    expect(result.status).toBe(0);
    const calls = parseInvocations(env);
    expect(calls.some((c) => c.name === 'curl')).toBe(true);

    // Read-only invariant: aws is only ever invoked with describe-stacks /
    // export-credentials, NEVER with `lambda invoke` and never with the literal
    // fetch payload.
    const fetchInvocations = calls.filter(
      (c) => c.name === 'aws' && c.args.includes('lambda invoke'),
    );
    expect(fetchInvocations).toEqual([]);
    const fetchPayloads = calls.filter((c) => c.args.includes('{"op":"fetch"}'));
    expect(fetchPayloads).toEqual([]);
  });

  it('unsigned probe returns 403; signed probe returns 429 twice, then 200; exit 0 with retry log', () => {
    setAwsBehavior(STACK_DESCRIBE_OK);
    const counterFile = join(env.dir, 'curl-attempts');
    writeFileSync(counterFile, '0');
    setCurlBehavior(`
counter="\${SHIM_BEHAVIOR_FILE_DIR}/curl-attempts"
n=\$(cat "\$counter")
if [[ " $* " == *" --aws-sigv4 "* ]]; then
  n=\$((n + 1))
  echo "\$n" > "\$counter"
  if [ "\$n" -le 2 ]; then
    write_body_and_code '' '429'
  else
    write_body_and_code '{"snapshotVersion":"v1","sources":[{"name":"weather","lastValue":"72F"}],"recentNotifications":[]}' '200'
  fi
else
  write_body_and_code '' '403'
fi
exit 0
`);
    setSleepBehavior(SLEEP_OK);

    const result = runSmoke(env);

    expect(result.status).toBe(0);
    const signedCurlCalls = parseInvocations(env).filter(
      (c) => c.name === 'curl' && c.args.includes('--aws-sigv4'),
    );
    // 2 retries (429 each) + 1 success (200) = 3 signed probes.
    expect(signedCurlCalls).toHaveLength(3);
  });

  it('signed probe returns 429 for the full retry window; script fails with bounded-retry message', () => {
    setAwsBehavior(STACK_DESCRIBE_OK);
    setCurlBehavior(`
if [[ " $* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '' '429'
else
  write_body_and_code '' '403'
fi
exit 0
`);
    setSleepBehavior(SLEEP_OK);

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/429/);
    expect(result.stderr).toMatch(
      /RESERVED_CONCURRENCY|reservedConcurrentExecutions|loop/,
    );
  }, 120_000);

  it('signed probe returns 403; script fails with IAM-grant message', () => {
    setAwsBehavior(STACK_DESCRIBE_OK);
    setCurlBehavior(`
if [[ " $* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '' '403'
else
  write_body_and_code '' '403'
fi
exit 0
`);
    setSleepBehavior(SLEEP_OK);

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lambda:InvokeFunctionUrl|URL grant|grantInvokeUrl/);
  });

  it('unsigned probe returns 200; script fails with URL-is-public regression message', () => {
    setAwsBehavior(STACK_DESCRIBE_OK);
    setCurlBehavior(`
if [[ " $* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '{}' '200'
else
  write_body_and_code '' '200'
fi
exit 0
`);
    setSleepBehavior(SLEEP_OK);

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/AWS_IAM|authType|infra\/stack\.ts/);
  });

  it('signed probe returns 200 with populated body missing weather.lastValue; script fails with field-missing message', () => {
    setAwsBehavior(STACK_DESCRIBE_OK);
    setCurlBehavior(`
if [[ " $* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '{"snapshotVersion":"v1","sources":[],"recentNotifications":[]}' '200'
else
  write_body_and_code '' '403'
fi
exit 0
`);
    setSleepBehavior(SLEEP_OK);

    const result = runSmoke(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/weather|lastValue/);
  });

  // Belt-and-suspenders invariant check: across every passing scenario above,
  // the script never invokes `aws lambda invoke` and never sends the literal
  // `{"op":"fetch"}` payload. This is the regression-sensitive assertion.
  it('across scenarios, smoke.sh never invokes fetch and never sends the fetch payload', () => {
    // Run the most-likely-to-trigger-write scenario: successful 200 path.
    setAwsBehavior(STACK_DESCRIBE_OK);
    setCurlBehavior(`
if [[ " $* " == *" --aws-sigv4 "* ]]; then
  write_body_and_code '{"snapshotVersion":"v1","sources":[{"name":"weather","lastValue":"72F"}],"recentNotifications":[]}' '200'
else
  write_body_and_code '' '403'
fi
exit 0
`);
    setSleepBehavior(SLEEP_OK);
    const result = runSmoke(env);
    expect(result.status).toBe(0);

    const calls = parseInvocations(env);
    const lambdaInvokeCalls = calls.filter(
      (c) => c.name === 'aws' && c.args.includes('lambda invoke'),
    );
    expect(lambdaInvokeCalls).toEqual([]);
    const fetchPayloadCalls = calls.filter((c) =>
      c.args.includes('{"op":"fetch"}'),
    );
    expect(fetchPayloadCalls).toEqual([]);
  });
});
