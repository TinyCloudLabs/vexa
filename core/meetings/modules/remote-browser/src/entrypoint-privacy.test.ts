import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../..');
const inventory = JSON.parse(readFileSync(path.join(root, 'scripts/log-privacy-entrypoints.json'), 'utf8')) as {
  entries: Array<{ id: string; test: string; test_scope: string; language: string; harness: string; target_file?: string }>;
};
const nodeRows = inventory.entries.filter((entry) => entry.test_scope === 'vexa-ci' && entry.language === 'node');
const botPackage = path.join(root, 'core/meetings/services/bot');
const browserPackage = path.join(root, 'core/meetings/modules/remote-browser');
const canaries = ['TC965_ENTRY_NAME_CANARY', 'TC965_ENTRY_TEXT_CANARY', 'xxx-xxxx-xxx', 'TC965_ENTRY_TOKEN_CANARY'];
const emitted = JSON.stringify({
  event: 'capture_signal.tape_started',
  frames: 7,
  participant_name: canaries[0],
  transcript: canaries[1],
  url: `https://meet.google.com/${canaries[2]}?ticket=${canaries[3]}`,
});

function test(name: string, run: () => void): void {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : 'unknown failure'}`);
    process.exitCode = 1;
  }
}

function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, expectedStatus = 0): string {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 20_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, expectedStatus, output);
  for (const canary of canaries) assert.ok(!output.includes(canary), `${canary} leaked: ${output}`);
  return output;
}

function row(id: string) {
  const found = nodeRows.find((entry) => entry.id === id);
  assert.ok(found, `missing inventory row ${id}`);
  if (id === 'bot.entrypoint-shell') {
    assert.equal(found.test, 'core/meetings/services/bot/src/entrypoint.test.ts::dynamic display path is absent from entrypoint logs');
  } else {
    assert.equal(found.test, `core/meetings/modules/remote-browser/src/entrypoint-privacy.test.ts::${id}`);
  }
  return found;
}
test('every Node entrypoint row has an explicit canary case', () => {
  assert.deepEqual(
    nodeRows.map((entry) => entry.id).sort(),
    ['bot.entrypoint-shell', 'bot.node-worker', 'bot.tsx-start', 'remote-browser.library', 'remote-browser.login-cli'].sort(),
  );
});

test('bot installs the sanitizer before any other module', () => {
  const source = readFileSync(path.join(botPackage, 'src/index.ts'), 'utf8');
  const imports = source.match(/^import .*;$/gm) ?? [];
  assert.equal(imports[0], "import './install-process-log-sanitizer.js';");
});

for (const id of ['bot.node-worker', 'bot.tsx-start']) {
  test(`inventory canary: ${id}`, () => {
    const target = row(id);
    const importUrl = new URL(`file://${path.resolve(root, target.target_file!)}`).href;
    const loader = id === 'bot.tsx-start' ? ['--import', 'tsx'] : [];
    const output = runNode([
      ...loader,
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(importUrl)}); console.log(${JSON.stringify(emitted)});`,
    ], botPackage);
    assert.match(output, /"event":"capture_signal\.tape_started"/);
    assert.match(output, /"frames":7/);
    if (id === 'bot.node-worker') {
      const worker = runNode(['dist/index.js'], botPackage, {
        VEXA_BOT_CONFIG: '{}',
        VEXA_CONNECTION_ID: `https://meet.google.com/xxx-xxxx-xxx?ticket=${canaries[3]}`,
      }, 1);
      assert.equal(worker, '', 'invalid bot configuration emitted startup output');
    }
  });
}

test('inventory canary: bot.entrypoint-shell', () => {
  const target = row('bot.entrypoint-shell');
  assert.equal(target.target_file, 'core/meetings/services/bot/entrypoint.sh');
  const testSource = readFileSync(path.join(botPackage, 'src/entrypoint.test.ts'), 'utf8');
  assert.ok(testSource.includes('TC965_DISPLAY_CANARY'));
});

test('inventory canary: remote-browser.library', () => {
  const target = row('remote-browser.library');
  const importPath = path.resolve(root, target.target_file!);
  const botSanitizer = path.resolve(botPackage, 'dist/install-process-log-sanitizer.js');
  const output = runNode([
    '--input-type=module',
    '-e',
    `await import(${JSON.stringify(new URL(`file://${botSanitizer}`).href)}); await import(${JSON.stringify(new URL(`file://${importPath}`).href)}); console.log(${JSON.stringify(emitted)});`,
  ], browserPackage);
  assert.match(output, /"frames":7/);
});

test('inventory canary: remote-browser.login-cli', () => {
  row('remote-browser.login-cli');
  const output = runNode(
    ['--import', 'tsx', 'src/provision-cli.ts'],
    browserPackage,
    { AUTH_PLATFORM: `TC965_ENTRY_NAME_CANARY_${canaries[0]}` },
    1,
  );
  assert.match(output, /"service":"remote-browser","event":"log_suppressed"/);
  const privacyModule = new URL(`file://${path.join(browserPackage, 'src/privacy-logging.ts')}`).href;
  const rawWrite = runNode([
    '--import', 'tsx', '--input-type=module', '-e',
    `await import(${JSON.stringify(privacyModule)}); process.stderr.write(${JSON.stringify(canaries.join(' '))});`,
  ], browserPackage);
  assert.match(rawWrite, /"service":"remote-browser","event":"log_suppressed","level":"error"/);
});
