/** Real Chromium failure events → join adapter → schema-valid failed lifecycle.
 * Admission is a fixture; this test does not claim a real Meet or an OOM reproduction.
 * Chromium is required: a missing browser is a failed validation, never a pass.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentBrowser } from '@vexa/remote-browser';
import { createBrowserJoinDriver } from './join-driver.js';
import { createOrchestrator } from './orchestrator.js';
import type { Invocation } from './config.js';
import type { LifecycleEvent } from './contracts.js';
import { noopActs, noopAloneness } from './test-doubles.js';

for (const action of ['crash', 'close'] as const) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vexa-browser-failure-'));
  const { context, page } = await launchPersistentBrowser({ dataDir, headless: true, args: ['--no-sandbox', '--mute-audio'] });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const inv: Invocation = { platform: 'google_meet', botName: 'Fixture', redisUrl: 'redis://localhost:6379' };
    const events: LifecycleEvent[] = [];
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let cleaned = false;
    const originalCrashListeners = page.listeners('crash');
    const originalCloseListeners = page.listeners('close');
    const driver = createBrowserJoinDriver(page, inv);
    const orchestrator = createOrchestrator(inv, {
      lifecycle: { async emit(event) { events.push(event); } },
      join: { ...driver, async join() { return 'admitted'; }, onRemoval() { return () => {}; } },
      pipeline: { async start() { started(); }, async stop() { cleaned = true; } },
      acts: noopActs(), aloneness: noopAloneness(),
    });
    const running = orchestrator.run();
    const ownedCrashListeners = page.listeners('crash').filter((listener) => !originalCrashListeners.includes(listener));
    const ownedCloseListeners = page.listeners('close').filter((listener) => !originalCloseListeners.includes(listener));
    assert.equal(ownedCrashListeners.length, 1);
    assert.equal(ownedCloseListeners.length, 1);
    await ready;
    const observedAt = Date.now();
    if (action === 'crash') {
      const cdp = await context.newCDPSession(page);
      void cdp.send('Page.crash').catch(() => {});
    } else {
      await page.close();
    }
    const result = await Promise.race([
      running,
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('browser failure was not reported within five seconds')), 5000); }),
    ]);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);
    const terminal = events.at(-1)!;
    assert.equal(terminal.failure_stage, 'active');
    assert.equal(terminal.completion_reason, undefined);
    assert(terminal.reason?.startsWith(action === 'crash' ? 'browser_crashed:' : 'browser_closed:'));
    assert(cleaned);
    assert(ownedCrashListeners.every((listener) => !page.listeners('crash').includes(listener)));
    assert(ownedCloseListeners.every((listener) => !page.listeners('close').includes(listener)));
    console.log(`PASS actual Chromium ${action}: failed with retained reason in ${Date.now() - observedAt} ms; capture cleanup ran`);
  } finally {
    if (deadline) clearTimeout(deadline);
    await context.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
