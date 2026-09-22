/**
 * L3 browser boundary — mirrored Meet media elements share one capture owner.
 *
 * Google Meet may render the same MediaStream through more than one playing
 * <audio>/<video> element while recycling its participant DOM. Capture resources
 * belong to the audio track, not the element: mirrors must not duplicate PCM and
 * removing or replacing one mirror must not tear down the remaining owner.
 *
 * Run: npx tsx src/gmeet-capture-dedup.boundary.test.ts
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentBrowser, type BrowserContext } from '@vexa/remote-browser';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = join(HERE, '..');
const BUNDLE = join(BOT_DIR, 'dist', 'browser-utils.global.js');

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : `  — ${detail}`}`);
  if (!condition) failed++;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Snapshot = {
  streams: number;
  resources: { contexts: number; sources: number; worklets: number; tracks: number };
  channels: number[];
  frames: number;
  logs: string[];
};

async function main(): Promise<void> {
  // Always rebuild: this boundary must exercise the current source, never a stale bundle.
  execSync('node build-browser-utils.mjs', { cwd: BOT_DIR, stdio: 'inherit' });

  const dataDir = mkdtempSync(join(tmpdir(), 'vexa-gmeet-dedup-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><body></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let context: BrowserContext;
  let page;
  try {
    ({ context, page } = await launchPersistentBrowser({
      dataDir,
      args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
      headless: true,
    }));
  } catch (error) {
    console.log(`  ⚠️ SKIP — headless Chromium unavailable in this environment: ${(error as Error).message?.split('\n')[0]}`);
    process.exit(0);
  }

  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.addScriptTag({ path: BUNDLE });
    await page.evaluate('globalThis.__name = globalThis.__name || ((target) => target);');
    await page.evaluate(`(async () => {
      const fixtureContext = new AudioContext({ sampleRate: 16000 });
      await fixtureContext.resume();
      const firstOscillator = fixtureContext.createOscillator();
      firstOscillator.frequency.value = 440;
      const firstDestination = fixtureContext.createMediaStreamDestination();
      firstOscillator.connect(firstDestination);
      firstOscillator.start();

      const makeElement = async (id, stream) => {
        const element = document.createElement('audio');
        element.id = id;
        element.autoplay = true;
        element.srcObject = stream;
        document.body.appendChild(element);
        await element.play();
        return element;
      };

      const first = await makeElement('first', firstDestination.stream);
      const mirror = await makeElement('mirror', firstDestination.stream);
      const channels = new Set();
      const logs = [];
      let frames = 0;
      const capture = globalThis.VexaBrowserUtils.createGmeetCapture({
        rescanMs: 20,
        findRetries: 1,
        findDelayMs: 1,
        silenceThreshold: 0,
        log(message) { logs.push(String(message)); },
        onAudio(channel) { channels.add(channel); frames++; },
      });
      await capture.start();
      globalThis.__dedupFixture = {
        capture, fixtureContext, firstOscillator, firstDestination, first, mirror,
        channels, logs, get frames() { return frames; }, replacementOscillator: null,
      };
    })()`);
    await sleep(400);

    const snapshot = async (): Promise<Snapshot> => page.evaluate(`(() => {
      const fixture = globalThis.__dedupFixture;
      return {
        streams: fixture.capture.streamCount(),
        resources: fixture.capture.resourceCounts(),
        channels: Array.from(fixture.channels).sort((a, b) => a - b),
        frames: fixture.frames,
        logs: fixture.logs,
      };
    })()`);

    const mirrored = await snapshot();
    check('two elements sharing one MediaStream have one capture owner',
      mirrored.streams === 1 && mirrored.resources.sources === 1 &&
      mirrored.resources.worklets === 1 && mirrored.resources.tracks === 1,
      JSON.stringify(mirrored));
    check('mirrored stream emits one stable channel',
      mirrored.frames > 0 && mirrored.channels.length === 1,
      JSON.stringify(mirrored));

    // Replace one mirror while the other still references the original stream.
    await page.evaluate(`(async () => {
      const fixture = globalThis.__dedupFixture;
      const oscillator = fixture.fixtureContext.createOscillator();
      oscillator.frequency.value = 880;
      const destination = fixture.fixtureContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      fixture.replacementOscillator = oscillator;
      fixture.first.srcObject = destination.stream;
      await fixture.first.play();
    })()`);
    await sleep(200);
    const replaced = await snapshot();
    check('replacing one mirror preserves the original owner and adds only the replacement owner',
      replaced.streams === 2 && replaced.resources.sources === 2 &&
      replaced.resources.worklets === 2 && replaced.resources.tracks === 2,
      JSON.stringify(replaced));

    await page.evaluate(`globalThis.__dedupFixture.mirror.remove()`);
    await sleep(150);
    const originalRemoved = await snapshot();
    check('removing the last original mirror releases only the original owner',
      originalRemoved.streams === 1 && originalRemoved.resources.sources === 1 &&
      originalRemoved.resources.worklets === 1 && originalRemoved.resources.tracks === 1,
      JSON.stringify(originalRemoved));

    await page.evaluate(`globalThis.__dedupFixture.first.remove()`);
    await sleep(150);
    const allRemoved = await snapshot();
    check('removing every element releases every capture resource',
      allRemoved.streams === 0 && allRemoved.resources.sources === 0 &&
      allRemoved.resources.worklets === 0 && allRemoved.resources.tracks === 0,
      JSON.stringify(allRemoved));

    await page.evaluate(`(async () => {
      const fixture = globalThis.__dedupFixture;
      fixture.capture.stop();
      fixture.firstOscillator.stop();
      fixture.replacementOscillator?.stop();
      await fixture.fixtureContext.close();
    })()`);
    const stopped = await snapshot();
    check('stop closes the shared capture context and leaves zero resources',
      stopped.resources.contexts === 0 && stopped.resources.sources === 0 &&
      stopped.resources.worklets === 0 && stopped.resources.tracks === 0,
      JSON.stringify(stopped));
  } finally {
    await context.close().catch(() => { /* best-effort */ });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failed === 0
    ? '\n✅ gmeet capture dedup boundary: all green'
    : `\n❌ gmeet capture dedup boundary: ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('❌ FAIL —', error?.stack || error);
  process.exit(1);
});
