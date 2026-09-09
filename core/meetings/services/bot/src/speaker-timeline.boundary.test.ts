/** Real browser bundle → recording tap → Node sink, over synthetic media and Meet-shaped DOM.
 * No real meeting, STT or external storage. Missing Chromium is a failure for this acceptance probe.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentBrowser } from '@vexa/remote-browser';
import { startCaptureBridge, startRecording } from './capture-bridge.js';
import { createBotRecordingSink } from './recording.js';
import type { Invocation } from './config.js';
import type { BotPipeline } from './pipeline.js';
import type { SpeakerTimelineChunk } from '@vexa/record-chunker';

const bundle = join(dirname(fileURLToPath(import.meta.url)), '../dist/browser-utils.global.js');
const dataDir = mkdtempSync(join(tmpdir(), 'vexa-speaker-timeline-'));
const oldTimeslice = process.env.VEXA_RECORDING_TIMESLICE_MS;
process.env.VEXA_RECORDING_TIMESLICE_MS = '500';
const { context, page } = await launchPersistentBrowser({ dataDir, headless: true,
  args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
  // Loopback is a trustworthy origin, as required by AudioWorklet; about:blank is not.
  await page.route('http://localhost/timeline-fixture', route => route.fulfill({ contentType: 'text/html',
    body: `<div data-participant-id="a" id="a"><span class="notranslate">Alice Fixture</span></div>
    <div data-participant-id="b" id="b"><span class="notranslate">Bob Fixture</span></div><audio id="remote" autoplay></audio>` }));
  await page.goto('http://localhost/timeline-fixture');
  await page.addScriptTag({ path: bundle });
  await page.evaluate('globalThis.__name = globalThis.__name || ((t, v) => t)');
  await page.evaluate(async () => {
    const w = globalThis as any;
    const ctx = new w.AudioContext({ sampleRate: 16000 });
    const oscillator = ctx.createOscillator();
    const output = ctx.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    await ctx.resume();
    w.document.getElementById('remote').srcObject = output.stream;
    await w.document.getElementById('remote').play();
    w.fixtureContext = ctx;
  });
  const inv: Invocation = { platform: 'google_meet', meetingUrl: 'https://meet.fixture.test/test',
    botName: 'Timeline fixture', redisUrl: 'redis://127.0.0.1:1', transcribeEnabled: false, recordingEnabled: true };
  let frames = 0;
  const pipeline: BotPipeline = { async start() {}, async stop() {},
    feedAudio() { frames++; }, feedMixedAudio() {}, recordHint() {} };
  const chunks: Array<{ seq: number; final: boolean; bytes: number; timeline?: SpeakerTimelineChunk }> = [];
  const sink = createBotRecordingSink({ inv, uploadChunk: (seq, final, _format, bytes, metadata) => {
    chunks.push({ seq, final, bytes: bytes.length, timeline: metadata as SpeakerTimelineChunk | undefined });
  } });
  const stopCapture = await startCaptureBridge(page, inv, pipeline);
  const stopRecording = await startRecording(page, inv, sink);
  const phase = async (ids: string[]) => {
    await page.evaluate((ids) => {
      const w = globalThis as any;
      for (const id of ['a', 'b']) w.document.getElementById(id).classList.toggle('speaking', ids.includes(id));
    }, ids);
    await page.waitForTimeout(1300);
  };
  await phase(['a']);
  await phase(['b']);
  await phase(['a', 'b']);
  await phase([]);
  await stopRecording();
  await stopCapture();
  await sink.close('fixture');
  const parts = chunks.flatMap(c => c.timeline ? [c.timeline] : []);
  const intervals = parts.flatMap(p => p.intervals);
  assert.ok(frames > 0, 'real synthetic PCM must cross capture boundary');
  assert.ok(chunks.some(c => c.bytes > 100), 'recording must contain audio');
  assert.ok(intervals.some(i => i.participant_id === 'a' && i.name === 'Alice Fixture'));
  assert.ok(intervals.some(i => i.participant_id === 'b' && i.name === 'Bob Fixture'));
  assert.ok(intervals.some(i => i.attribution === 'overlap'));
  assert.ok(intervals.some(i => i.attribution === 'unknown'));
  assert.equal(new Set(parts.map(p => p.recording_started_at_ms)).size, 1);
  assert.ok(chunks.at(-1)?.final);
  assert.deepEqual(chunks.map(c => c.seq), chunks.map((_, i) => i));
  for (let i = 1; i < intervals.length; i++) assert.equal(intervals[i]!.start_ms, intervals[i - 1]!.end_ms);
  assert.ok(await page.evaluate(() => !(globalThis as any).__vexaRecordingTimelineTimer), 'timeline timer cleaned up');
  console.log(JSON.stringify({ result: 'pass', frames, chunks: chunks.length, intervals: intervals.length,
    recording_ms: intervals.at(-1)?.end_ms, attribution: [...new Set(intervals.map(i => i.attribution))] }));
} finally {
  if (oldTimeslice === undefined) delete process.env.VEXA_RECORDING_TIMESLICE_MS;
  else process.env.VEXA_RECORDING_TIMESLICE_MS = oldTimeslice;
  await context.close();
  rmSync(dataDir, { recursive: true, force: true });
}
