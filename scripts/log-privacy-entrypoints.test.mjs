import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverEntrypoints, exclusionMatches, uncoveredEntrypoints } from './log-privacy-discovery.mjs';

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
      const [testPath, ...selectorParts] = entry.test.split('::');
      const testSource = source(testPath);
      const selector = selectorParts.join('::').replace(/\[[^\]]*\]$/, '');
      assert.ok(selector && testSource.includes(selector), `${entry.id}: stale test selector ${selector}`);
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

test('every entrypoint lists source-backed third-party logger neutralizers', () => {
  const mapping = inventory.third_party_loggers;
  const policies = inventory.third_party_logger_policies;
  assert.deepEqual(Object.keys(mapping).sort(), entries.map((entry) => entry.id).sort());
  const libraries = new Set();
  for (const entry of entries) {
    assert.ok(Array.isArray(mapping[entry.id]), `${entry.id}: third-party logger column is missing`);
    for (const policyId of mapping[entry.id]) {
      const policy = policies[policyId];
      assert.ok(policy, `${entry.id}: missing logger policy ${policyId}`);
      assert.ok(policy.library?.trim(), `${policyId}: library name is missing`);
      assert.ok(policy.neutralizer?.trim(), `${policyId}: neutralizer is missing`);
      assert.ok(Array.isArray(policy.checks) && policy.checks.length > 0, `${policyId}: no neutralizer checks`);
      libraries.add(policy.library.toLowerCase());
      for (const check of policy.checks) {
        assert.ok(source(check.file).includes(check.contains), `${policyId}: missing ${check.contains} in ${check.file}`);
      }
    }
  }
  for (const library of ['uvicorn', 'fastapi-guard', 'redis-py', 'sqlalchemy', 'charset-normalizer', 'aiohttp', 'urllib3']) {
    assert.ok([...libraries].some((listed) => listed.includes(library)), `${library} handler audit is missing`);
  }
});

test('every SQLAlchemy engine hides bound parameters', () => {
  const skippedDirectories = new Set(['.git', '.venv', 'node_modules', 'dist', 'build', 'coverage', '.turbo', '.next']);
  const filesUnder = (directory) => {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) files.push(...filesUnder(path.join(directory, entry.name)));
      } else if (entry.isFile() && /\.(?:py|ya?ml)$/.test(entry.name)) {
        files.push(path.join(directory, entry.name));
      }
    }
    return files;
  };
  const constructors = [];
  for (const file of filesUnder(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (/create_(?:async_)?engine\(/.test(line)) constructors.push({ file: relative, line });
    }
  }
  assert.ok(constructors.length, 'no SQLAlchemy engine constructors found');
  for (const { file, line } of constructors) {
    if (line.includes('**engine_pool_kwargs()')) {
      assert.ok(source('core/meetings/services/meeting-api/src/meeting_api/db.py').includes('"hide_parameters": True'));
    } else if (line.includes('**kwargs')) {
      assert.equal(file, 'core/identity/services/admin-api/src/admin_api/app/db.py');
      assert.ok(source(file).includes('"hide_parameters": True'));
    } else {
      assert.match(line, /hide_parameters=True/, `${file}: engine constructor does not hide bound parameters`);
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

test('discovery requires every executable launch target to be covered or explicitly excluded', () => {
  const candidates = discoverEntrypoints(root);
  const uncovered = uncoveredEntrypoints(candidates, inventory);
  assert.deepEqual(uncovered, [], `entrypoint inventory is missing:\n${uncovered.map(({ key, target }) => `${key}: ${target}`).join('\n')}`);
  const candidateKeys = new Set(candidates.map(({ key }) => key));
  const covered = inventory.entries.flatMap((entry) => entry.discovered ?? []);
  const exclusions = inventory.exclusions ?? [];
  const excluded = exclusions.flatMap((exclusion) => exclusion.keys ?? []);
  assert.equal(new Set([...covered, ...excluded]).size, covered.length + excluded.length, 'entrypoint discovery keys must be unique');
  for (const key of [...covered, ...excluded]) assert.ok(candidateKeys.has(key), `stale discovery key: ${key}`);
  for (const exclusion of exclusions) {
    assert.ok(exclusion.reason?.trim(), `${(exclusion.keys ?? []).join(', ')} needs an exclusion reason`);
    for (const pattern of exclusion.patterns ?? []) {
      assert.ok([...candidateKeys].some((key) => exclusionMatches(pattern, key)), `stale exclusion pattern: ${pattern}`);
    }
  }
  for (const candidate of candidates) {
    const rowMatches = inventory.entries.filter((entry) => (entry.discovered ?? []).includes(candidate.key)).length;
    const exclusionMatchesCount = exclusions.filter((exclusion) =>
      (exclusion.keys ?? []).includes(candidate.key) ||
      (exclusion.patterns ?? []).some((pattern) => exclusionMatches(pattern, candidate.key))).length;
    assert.equal(rowMatches + exclusionMatchesCount, 1, `${candidate.key}: expected exactly one manifest row or explicit exclusion`);
  }
  for (const entry of entries) {
    if (entry.discovered !== undefined) assert.ok(Array.isArray(entry.discovered), `${entry.id}: discovered sources must be an array`);
  }
});

test('Astra mutation fixture is detected as an uncovered runnable entrypoint', () => {
  const fixtureRoot = path.join(root, 'scripts/probe');
  const candidates = discoverEntrypoints(fixtureRoot);
  assert.deepEqual(
    candidates.map(({ key }) => key),
    [
      'package:package.json#bin:tc965-diagnostic',
      'package:package.json#script:start:diagnostic',
    ],
  );
  assert.deepEqual(uncoveredEntrypoints(candidates, { entries: [], exclusions: [] }), candidates);
  const result = spawnSync(process.execPath, ['diagnostic-cli.mjs'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TC965_MUTATION_RAW_CANARY https:\/\/meet\.google\.com\/xxx-xxxx-xxx\?ticket=TC965_MUTATION_TOKEN/);
});
