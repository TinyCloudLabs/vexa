/** Production checkpoint privacy against a real browser and filesystem.
 * Run inside the networkless bot container; only synthetic page content is used.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
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
      console.log(`PASS checkpoint privacy flag=${label}: protected initial/child/relative/normalized paths, unrelated paths unchanged`);
    } finally {
      await session.close();
    }
  }
} finally {
  if (previous === undefined) delete process.env.VEXA_CHECKPOINT_SCREENSHOTS;
  else process.env.VEXA_CHECKPOINT_SCREENSHOTS = previous;
  for (const directory of [checkpointScope, unrelatedScope, siblingScope]) rmSync(directory, { recursive: true, force: true });
}
