/** Production checkpoint privacy against a real browser and filesystem.
 * Run inside the networkless bot container; only synthetic page content is used.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { launchBrowser } from './capture-bridge.js';
import type { Invocation } from './config.js';

assert.equal(process.env.NODE_ENV, 'production', 'exercise the production environment');
const checkpointRoot = '/app/storage/screenshots';
mkdirSync(checkpointRoot, { recursive: true });
const checkpointScope = mkdtempSync(join(checkpointRoot, 'tc2181-policy-'));
const unrelatedScope = mkdtempSync(join(tmpdir(), 'tc2181-unrelated-'));
const siblingScope = mkdtempSync('/app/storage/screenshots-unrelated-tc2181-');
const previous = process.env.VEXA_CHECKPOINT_SCREENSHOTS;
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const invocation: Invocation = { platform: 'google_meet', botName: 'Synthetic privacy fixture', redisUrl: 'redis://invalid' };
try {
  for (const flag of [undefined, '0', 'false', 'true', '1']) {
    await test(`checkpoint privacy flag=${flag ?? 'unset'}`, async t => {
    if (flag === undefined) delete process.env.VEXA_CHECKPOINT_SCREENSHOTS;
    else process.env.VEXA_CHECKPOINT_SCREENSHOTS = flag;
    const enabled = flag === '1';
    const session = await launchBrowser(invocation);
    try {
      await session.context.route('**/*', route => route.abort());
      await session.page.setContent('<html><body><button>Local synthetic page</button></body></html>');
      const label = flag ?? 'unset';
      const direct = join(checkpointScope, label + '-direct.png');
      const relativeTarget = join(checkpointScope, label + '-relative.png');
      const normalizedTarget = join(checkpointScope, label + '-normalized.png');
      const childTarget = join(checkpointScope, label + '-child.png');
      const child = await session.context.newPage();
      await child.setContent('<html><body><p>Local child page</p></body></html>');
      for (const [page, path, target] of [
        [session.page, direct, direct],
        [session.page, relative(process.cwd(), relativeTarget), relativeTarget],
        [session.page, checkpointScope + '/nested/../' + basename(normalizedTarget), normalizedTarget],
        [child, childTarget, childTarget],
      ] as const) {
        const pixels = await page.screenshot({ path });
        assert.equal(existsSync(target), enabled, `${label}: checkpoint disk output must require explicit opt-in`);
        if (enabled) {
          assert.deepEqual(pixels.subarray(0, 8), signature, 'opt-in emits a real PNG');
          assert.deepEqual(readFileSync(target), pixels);
        } else {
          assert.equal(pixels.byteLength, 0, 'disabled checkpoint returns no page pixels');
        }
      }
      const unrelated = join(unrelatedScope, label + '.png');
      const sibling = join(siblingScope, label + '.png');
      const escaped = checkpointScope + '/../../' + basename(siblingScope) + '/' + label + '-escaped.png';
      for (const path of [unrelated, sibling, escaped]) {
        const pixels = await session.page.screenshot({ path });
        assert.deepEqual(readFileSync(path).subarray(0, 8), signature, 'non-checkpoint captures retain their existing behavior');
        assert.deepEqual(pixels.subarray(0, 8), signature);
      }
      const memoryOnly = await session.page.screenshot();
      assert.deepEqual(memoryOnly.subarray(0, 8), signature, 'pathless screenshots are outside the checkpoint-file policy');
      await t.test('a later separate browser context keeps the checkpoint policy', async () => {
        const browser = session.context.browser();
        assert.ok(browser);
        const later = await browser.newContext();
        try {
          const page = await later.newPage();
          await page.setContent('<html><body>Separate synthetic context</body></html>');
          const target = join(checkpointScope, label + '-separate-context.png');
          const pixels = await page.screenshot({ path: target });
          assert.equal(existsSync(target), enabled, 'a separate context must not bypass checkpoint opt-in');
          assert.equal(pixels.byteLength === 0, !enabled);
          const outside = join(unrelatedScope, label + '-separate-context.png');
          await page.screenshot({ path: outside });
          assert.deepEqual(readFileSync(outside).subarray(0, 8), signature);
        } finally {
          await later.close();
        }
      });
      await t.test('browser.newPage keeps the checkpoint policy', async () => {
        const browser = session.context.browser();
        assert.ok(browser);
        const page = await browser.newPage();
        try {
          const target = join(checkpointScope, label + '-browser-page.png');
          const pixels = await page.screenshot({ path: target });
          assert.equal(existsSync(target), enabled);
          assert.equal(pixels.byteLength === 0, !enabled);
        } finally {
          await page.close();
        }
      });

      const inwardDirectory = join(unrelatedScope, label + '-inward-directory');
      const outwardDirectory = join(checkpointScope, label + '-outward-directory');
      symlinkSync(checkpointScope, inwardDirectory);
      symlinkSync(unrelatedScope, outwardDirectory);
      const existingTarget = join(checkpointScope, label + '-existing.png');
      const existingBytes = Buffer.from('pre-existing checkpoint file');
      writeFileSync(existingTarget, existingBytes);
      const existingAlias = join(unrelatedScope, label + '-existing-alias.png');
      symlinkSync(existingTarget, existingAlias);
      const danglingTarget = join(checkpointScope, label + '-dangling.png');
      const danglingAlias = join(unrelatedScope, label + '-dangling-alias.png');
      symlinkSync(danglingTarget, danglingAlias);
      const outsideTarget = join(unrelatedScope, label + '-outward-file.png');
      const outwardAlias = join(checkpointScope, label + '-outward-file.png');
      symlinkSync(outsideTarget, outwardAlias);
      const chain = join(unrelatedScope, label + '-chain');
      symlinkSync(basename(inwardDirectory), chain);
      for (const item of [
        { name: 'symlinked ancestor and missing suffix', path: join(inwardDirectory, label, 'nested', 'new.png'), target: join(checkpointScope, label, 'nested', 'new.png'), protected: true },
        { name: 'existing output-file alias', path: existingAlias, target: existingTarget, protected: true, existing: existingBytes },
        { name: 'dangling output-file alias', path: danglingAlias, target: danglingTarget, protected: true },
        { name: 'relative chained ancestor alias', path: join(chain, label + '-chain.png'), target: join(checkpointScope, label + '-chain.png'), protected: true },
        { name: 'missing prefix before dot-dot and inward alias', path: unrelatedScope + '/' + label + '-missing/../' + basename(inwardDirectory) + '/' + label + '-reentered.png', target: join(checkpointScope, label + '-reentered.png'), protected: true },
        { name: 'missing prefix before dot-dot and outward alias', path: checkpointScope + '/' + label + '-missing/../' + basename(outwardDirectory) + '/' + label + '-reentered-outside.png', target: join(unrelatedScope, label + '-reentered-outside.png'), protected: false },
        { name: 'effective outside directory', path: join(outwardDirectory, label + '-outside.png'), target: join(unrelatedScope, label + '-outside.png'), protected: false },
        { name: 'effective outside output-file alias', path: outwardAlias, target: outsideTarget, protected: false },
      ]) {
        await t.test(item.name, async () => {
          const pixels = await session.page.screenshot({ path: item.path });
          if (item.protected && !enabled) {
            assert.equal(pixels.byteLength, 0, 'an effective checkpoint destination must return no pixels');
            if (item.existing) assert.deepEqual(readFileSync(item.target), item.existing);
            else assert.equal(existsSync(item.target), false, 'no effective checkpoint file may be created');
          } else {
            assert.deepEqual(pixels.subarray(0, 8), signature);
            assert.deepEqual(readFileSync(item.target), pixels, 'effective outside destinations remain usable');
          }
        });
      }
      await t.test('cyclic output aliases retain filesystem refusal', async () => {
        const cycle = join(unrelatedScope, label + '-cycle.png');
        symlinkSync(basename(cycle), cycle);
        await assert.rejects(session.page.screenshot({ path: cycle }), { code: 'ELOOP' });
      });
      console.log(`Checked checkpoint privacy flag=${label}: browser lifecycle and effective filesystem destinations`);
    } finally {
      await session.close();
    }
    });
  }
} finally {
  if (previous === undefined) delete process.env.VEXA_CHECKPOINT_SCREENSHOTS;
  else process.env.VEXA_CHECKPOINT_SCREENSHOTS = previous;
  for (const directory of [checkpointScope, unrelatedScope, siblingScope]) rmSync(directory, { recursive: true, force: true });
}
