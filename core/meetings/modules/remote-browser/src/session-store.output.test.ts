import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'session-store-output-'));
const source = join(process.cwd(), 'src/session-store.ts');
const child = `
  const { mkdirSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { syncBrowserDataFromS3 } = require(${JSON.stringify(source)});
  const root = ${JSON.stringify(root)};
  const bin = join(root, 'bin');
  mkdirSync(bin, {recursive:true});
  const aws = join(bin, 'aws');
  writeFileSync(aws, '#!/bin/sh\\necho SYNTH_AWS_STDOUT_611\\necho SYNTH_AWS_STDERR_612 >&2\\nexit 1\\n');
  chmodSync(aws, 0o755);
  process.env.PATH = bin + ':' + process.env.PATH;
  try { syncBrowserDataFromS3({userdataS3Path:'SYNTH_S3_KEY_613', s3Bucket:'SYNTH_BUCKET_614', s3Endpoint:'https://SYNTH_HOST_615'}, '/private/SYNTH_PATH_616'); }
  catch (error) { console.error(error instanceof Error ? error.message : 'sync_failed'); }
  rmSync(root, {recursive:true, force:true});
`;
const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', child], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
try {
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr;
  for (const canary of ['SYNTH_AWS_STDOUT_611', 'SYNTH_AWS_STDERR_612', 'SYNTH_S3_KEY_613', 'SYNTH_BUCKET_614', 'SYNTH_HOST_615', 'SYNTH_PATH_616']) {
    assert.equal(output.includes(canary), false, `session-store output leaked ${canary}`);
  }
  assert.match(output, /session-restore failed: aws sync failed/);
  console.log('PASS session-store output: AWS child stdout/stderr and S3 keys stay out of process output');
} finally {
  rmSync(root, { recursive: true, force: true });
}
