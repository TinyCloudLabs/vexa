import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(readFileSync(path.join(root, 'scripts/log-privacy-entrypoints.json'), 'utf8'));
const entries = inventory.entries;
const rowById = new Map(entries.map((entry) => [entry.id, entry]));

function source(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('entrypoint inventory is complete and every code-owned row has a CI harness', () => {
  assert.equal(inventory.version, 1);
  assert.equal(rowById.size, entries.length, 'entrypoint IDs must be unique');
  for (const entry of entries) {
    for (const field of ['id', 'target', 'service', 'used_in_ptx_dev', 'privacy', 'test', 'test_scope', 'logging_driver']) {
      assert.equal(typeof entry[field], 'string', `${entry.id}: missing ${field}`);
      assert.ok(entry[field].length, `${entry.id}: empty ${field}`);
    }
    if (entry.test_scope === 'vexa-ci') {
      assert.ok(['python', 'node'].includes(entry.language), `${entry.id}: unsupported CI language`);
      const allowedHarnesses = entry.language === 'python'
        ? ['python-main', 'python-uvicorn', 'python-rollback']
        : ['bot-process', 'bot-shell', 'bot-library', 'browser-cli'];
      assert.ok(allowedHarnesses.includes(entry.harness), `${entry.id}: missing explicit CI canary implementation`);
      if (entry.harness === 'python-rollback') assert.equal(entry.id, 'meeting-api.rollback');
      const [testPath] = entry.test.split('::');
      const testSource = source(testPath);
      if (entry.harness === 'python-rollback') {
        assert.ok(testSource.includes('987654321'), `${entry.id}: rollback-ID canary test is missing`);
      } else {
        const canarySource = entry.language === 'python' ? source('scripts/entrypoint_privacy_python.py') : testSource;
        assert.ok(canarySource.includes('TC965'), `${entry.id}: referenced test has no TC965 canary`);
      }
    } else {
      assert.equal(entry.test_scope, 'ptx-shipper', `${entry.id}: unknown test scope`);
      assert.equal(entry.harness, 'external-drop', `${entry.id}: external process must use explicit drop coverage`);
      assert.match(entry.privacy, /^external \/ compose-only: not shipped; dropped by the ptx-dev shipper's source allowlist/);
      assert.match(entry.test, /ptx-dev shipper allowlist test/);
    }
  }
});

test('all app Dockerfile commands and package start/login scripts have inventory rows', () => {
  const launchFiles = [
    'core/meetings/services/meeting-api/Dockerfile',
    'core/gateway/services/gateway/Dockerfile',
    'core/identity/services/admin-api/Dockerfile',
    'core/runtime/Dockerfile',
    'core/meetings/services/bot/Dockerfile',
  ];
  for (const file of launchFiles) {
    const text = source(file);
    const lines = text.split(/\r?\n/).filter((line) => /^\s*(?:CMD|ENTRYPOINT)\s+/.test(line));
    assert.ok(lines.length, `${file}: Dockerfile launch target is not inventoried`);
    for (const line of lines) {
      if (line.includes('entrypoint.sh')) {
        assert.ok(entries.some((entry) => entry.id === 'bot.entrypoint-shell'), `${file}: shell entrypoint missing from inventory`);
        continue;
      }
      const argv = JSON.parse(line.replace(/^\s*(?:CMD|ENTRYPOINT)\s+/, ''));
      const command = argv.join(' ');
      assert.ok(entries.some((entry) => entry.target === command || entry.target.endsWith(`: ${command}`) || entry.target.includes(command)), `${file}: untracked launch target ${command}`);
    }
  }
  for (const sourceRoot of [
    'core/meetings/services/meeting-api/src',
    'core/gateway/services/gateway/src',
    'core/identity/services/admin-api/src',
  ]) {
    const base = path.join(root, sourceRoot);
    const files = readdirSync(base, { recursive: true }).filter((file) => typeof file === 'string' && file.endsWith('.py'));
    for (const file of files) {
      const text = readFileSync(path.join(base, file), 'utf8');
      const hasMain = file.endsWith('/__main__.py') || /if\s+__name__\s*==\s*['"]__main__['"]/.test(text);
      if (!hasMain) continue;
      const module = file.replace(/\.py$/, '').split(path.sep).join('.');
      assert.ok(entries.some((entry) => entry.module === module || entry.target_module?.startsWith(`${module}:`)), `${sourceRoot}/${file}: executable Python module missing from inventory`);
    }
  }

  const dockerBackend = source('core/runtime/src/runtime_kernel/docker_backend.py');
  assert.doesNotMatch(dockerBackend, /["']LogConfig["']/);
  assert.match(rowById.get('bot.node-worker').logging_driver, /inherits daemon default/);

  for (const [file, scriptNames] of [
    ['core/meetings/services/bot/package.json', ['start']],
    ['core/meetings/modules/remote-browser/package.json', ['login']],
  ]) {
    const scripts = JSON.parse(source(file)).scripts;
    for (const name of scriptNames) {
      const command = scripts[name];
      assert.ok(command, `${file}: missing expected ${name} script`);
      assert.ok(entries.some((entry) => entry.target.includes(command)), `${file}: untracked ${name} target ${command}`);
    }
  }

  const shell = source('core/meetings/services/bot/entrypoint.sh');
  assert.match(shell, /node "\$\{BOT_WORKER_ENTRY:-dist\/index\.js\}"/);
  assert.ok(rowById.has('bot.node-worker'), 'bot node worker target missing from inventory');
});

test('inventory table renderer uses the same manifest consumed by CI', () => {
  const renderer = source('scripts/render-log-privacy-entrypoints.mjs');
  assert.match(renderer, /log-privacy-entrypoints\.json/);
});
