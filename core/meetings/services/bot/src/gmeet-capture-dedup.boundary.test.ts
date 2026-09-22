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
  resources: { contexts: number; sources: number; worklets: number; tracks: number; references: number };
  channels: number[];
  frames: number;
  framesByChannel: Record<number, number>;
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
      const channels = new Set();
      const framesByChannel = {};
      const logs = [];
      let frames = 0;
      const capture = globalThis.VexaBrowserUtils.createGmeetCapture({
        rescanMs: 20,
        findRetries: 1,
        findDelayMs: 1,
        silenceThreshold: 0,
        log(message) { logs.push(String(message)); },
        onAudio(channel) { channels.add(channel); frames++; framesByChannel[channel] = (framesByChannel[channel] || 0) + 1; },
      });
      await capture.start();
      globalThis.__dedupFixture = {
        capture, fixtureContext, firstOscillator, firstDestination, first, replacement: null, mirror: null,
        channels, framesByChannel, logs, get frames() { return frames; }, replacementOscillator: null,
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
        framesByChannel: fixture.framesByChannel,
        logs: fixture.logs,
      };
    })()`);

    const mirrored = await snapshot();
    check('one live element has one capture owner',
      mirrored.streams === 1 && mirrored.resources.sources === 1 &&
      mirrored.resources.worklets === 1 && mirrored.resources.tracks === 1 && mirrored.resources.references === 1,
      JSON.stringify(mirrored));
    check('initial stream emits channel zero',
      mirrored.frames > 0 && mirrored.channels.length === 1 && mirrored.channels[0] === 0,
      JSON.stringify(mirrored));

    // Meet can append/play a replacement with the same srcObject and remove the old element
    // before the next scan. This must hand over the existing owner, not create channel 1.
    await page.evaluate(`(async () => {
      const fixture = globalThis.__dedupFixture;
      fixture.replacement = await (async () => {
        const element = document.createElement('audio');
        element.autoplay = true;
        element.srcObject = fixture.firstDestination.stream;
        document.body.appendChild(element);
        await element.play();
        return element;
      })();
      fixture.first.remove();
    })()`);
    await sleep(200);
    const handedOver = await snapshot();
    check('same-track DOM handover keeps one owner and channel zero PCM',
      handedOver.streams === 1 && handedOver.resources.sources === 1 &&
      handedOver.resources.worklets === 1 && handedOver.resources.tracks === 1 && handedOver.resources.references === 1 &&
      handedOver.frames > mirrored.frames && handedOver.channels.length === 1 && handedOver.channels[0] === 0,
      JSON.stringify(handedOver));

    // A mirror retains the original owner while the handover element is repurposed to a new track.
    await page.evaluate(`(async () => {
      const fixture = globalThis.__dedupFixture;
      fixture.mirror = await (async () => {
        const element = document.createElement('audio');
        element.autoplay = true;
        element.srcObject = fixture.firstDestination.stream;
        document.body.appendChild(element);
        await element.play();
        return element;
      })();
      const oscillator = fixture.fixtureContext.createOscillator();
      oscillator.frequency.value = 880;
      const destination = fixture.fixtureContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      fixture.replacementOscillator = oscillator;
      fixture.replacement.srcObject = destination.stream;
      await fixture.replacement.play();
    })()`);
    await sleep(400);
    const replaced = await snapshot();
    check('mirror preserves channel zero PCM while replacement adds exactly channel one',
      replaced.streams === 2 && replaced.resources.sources === 2 &&
      replaced.resources.worklets === 2 && replaced.resources.tracks === 2 && replaced.resources.references === 2 &&
      JSON.stringify(replaced.channels) === JSON.stringify([0, 1]) &&
      (replaced.framesByChannel[0] || 0) > (handedOver.framesByChannel[0] || 0) &&
      (replaced.framesByChannel[1] || 0) > 0,
      JSON.stringify(replaced));
    check('repurposing an earlier element never transiently reconnects the mirrored owner',
      replaced.logs.filter((message) => message.startsWith('stream ') && message.includes(' connected ')).length === 2 &&
      replaced.logs.filter((message) => message.startsWith('stream 0 connected ')).length === 1 &&
      replaced.logs.filter((message) => message.startsWith('stream 1 connected ')).length === 1 &&
      !replaced.logs.some((message) => message.startsWith('stream 2 connected ')),
      JSON.stringify(replaced));

    await page.evaluate(`globalThis.__dedupFixture.mirror.remove()`);
    await sleep(150);
    const originalRemoved = await snapshot();
    check('removing the last original mirror releases only the original owner',
      originalRemoved.streams === 1 && originalRemoved.resources.sources === 1 &&
      originalRemoved.resources.worklets === 1 && originalRemoved.resources.tracks === 1 && originalRemoved.resources.references === 1,
      JSON.stringify(originalRemoved));

    await page.evaluate(`globalThis.__dedupFixture.replacement.remove()`);
    await sleep(150);
    const allRemoved = await snapshot();
    check('removing every element releases every capture resource',
      allRemoved.streams === 0 && allRemoved.resources.sources === 0 &&
      allRemoved.resources.worklets === 0 && allRemoved.resources.tracks === 0 && allRemoved.resources.references === 0,
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
      stopped.resources.worklets === 0 && stopped.resources.tracks === 0 && stopped.resources.references === 0,
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
