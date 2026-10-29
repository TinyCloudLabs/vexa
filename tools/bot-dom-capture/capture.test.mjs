import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const requireJoin = createRequire(new URL('../../core/meetings/modules/join/package.json', import.meta.url));
const { JSDOM } = requireJoin('jsdom');
const { sanitizeDocument } = createRequire(import.meta.url)('./preload.cjs');
const cli = fileURLToPath(new URL('./prepare.mjs', import.meta.url));

function withDirectory(run) {
  const root = mkdtempSync(join(tmpdir(), 'vexa-local-capture-test-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('local capture refuses to prepare without explicit local-only consent', () => withDirectory(root => {
  const result = spawnSync(process.execPath, [cli, '--output', join(root, 'out')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /LOCAL_CAPTURE_OPT_IN_REQUIRED/);
}));

test('preparation creates private consent and mount options, never reuses a directory', () => withDirectory(root => {
  const output = join(root, 'out');
  const args = [cli, '--local-only', '--output', output];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(statSync(output).mode & 0o777, 0o700);
  const marker = join(output, 'LOCAL_DIAGNOSTIC_ONLY.json');
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { local_only: true, mode: 'failure', format_version: 1 });
  const options = JSON.parse(readFileSync(join(output, 'docker-options.private.json'), 'utf8'));
  assert.ok(options.mounts.some(mount => mount.target === '/opt/vexa-local-dom-capture' && mount.readOnly));
  assert.equal(options.environment.NODE_OPTIONS, '--require=/opt/vexa-local-dom-capture/preload.cjs');
  const again = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /LOCAL_CAPTURE_FRESH_DIRECTORY_REQUIRED/);
}));

test('preparation rejects an output symlink rather than following it', () => withDirectory(root => {
  const output = join(root, 'link');
  symlinkSync(root, output);
  const result = spawnSync(process.execPath, [cli, '--local-only', '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /LOCAL_CAPTURE_FRESH_DIRECTORY_REQUIRED/);
}));

test('DOM capture keeps static lobby controls but discards arbitrary text and attributes', () => {
  const canaries = ['PRIVATE_PERSON_CANARY', 'private@example.invalid', 'abc-defg-hij', 'TOKEN_CANARY', 'ACCOUNT_CANARY', 'PRIVATE_COMMENT_CANARY', 'PRIVATE_TEMPLATE_CANARY'];
  const doc = new JSDOM(`<!doctype html><html lang="en"><head><title>PRIVATE_PERSON_CANARY</title>
    <script>TOKEN_CANARY</script><style>.private{background:url(https://example.invalid/TOKEN_CANARY)}</style></head><body>
    <!-- PRIVATE_COMMENT_CANARY -->
    <div data-participant-id="ACCOUNT_CANARY">Ask to join</div><div>PRIVATE_PERSON_CANARY private@example.invalid abc-defg-hij</div>
    <input jsname="YPqjbf" aria-label="Your name" value="PRIVATE_PERSON_CANARY" data-email="private@example.invalid">
    <button aria-label="Ask to join without microphone &amp; camera"><span jsname="V67aGc">Ask to join</span></button>
    <button aria-label="PRIVATE_PERSON_CANARY" id="ACCOUNT_CANARY" class="PRIVATE_PERSON_CANARY" onclick="TOKEN_CANARY">PRIVATE_PERSON_CANARY</button>
    <a href="https://example.invalid/TOKEN_CANARY">private@example.invalid</a>
    <iframe src="https://example.invalid/TOKEN_CANARY"></iframe><img src="https://example.invalid/TOKEN_CANARY">
    <svg><text>PRIVATE_PERSON_CANARY</text></svg><textarea>PRIVATE_PERSON_CANARY</textarea>
    <template><div data-name="PRIVATE_TEMPLATE_CANARY">PRIVATE_TEMPLATE_CANARY</div></template>
  </body></html>`).window.document;
  const captured = sanitizeDocument(doc);
  for (const canary of canaries) assert.equal(captured.includes(canary), false, `DOM leaked ${canary}`);
  assert.doesNotMatch(captured, /https?:|<script|<style|<iframe|<img|<svg|onclick|data-email|value=/i);
  const clean = new JSDOM(captured).window.document;
  assert.equal(clean.documentElement.lang, 'en');
  assert.equal(clean.querySelector('input[jsname="YPqjbf"]').getAttribute('aria-label'), 'Your name');
  assert.equal(clean.querySelector('button').getAttribute('aria-label'), 'Ask to join without microphone & camera');
  assert.equal(clean.querySelector('button span').textContent, 'Ask to join');
  assert.equal(clean.querySelector('[data-participant-id]'), null);
});

test('sanitizing C retains the actual successful name and join controls without adding a selector fallback', () => {
  const fixture = readFileSync(new URL('../../core/meetings/modules/join/src/googlemeet/fixtures/captured-c-guest-lobby.html', import.meta.url), 'utf8');
  const clean = new JSDOM(sanitizeDocument(new JSDOM(fixture).window.document)).window.document;
  assert.equal(clean.querySelector('input[placeholder="Your name"]').getAttribute('jsname'), 'YPqjbf');
  assert.equal(clean.querySelector('button').getAttribute('aria-label'), 'Ask to join without microphone & camera');
  assert.equal(clean.querySelector('button span[jsname="V67aGc"]').textContent, 'Ask to join');
});
