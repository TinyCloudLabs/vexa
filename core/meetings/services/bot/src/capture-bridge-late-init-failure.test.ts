import assert from 'node:assert/strict';
import { startCaptureBridge } from './capture-bridge.js';
import { createLivePipeline, type BotPipeline } from './pipeline.js';
import type { Invocation } from './config.js';

// The capture module proves the real late-rescan addModule rejection is retained by stop(). This
// boundary drives that retained failure through the real bridge and live pipeline: the terminal
// lifecycle must fail before the attributed recorder can manufacture an empty successful close.
const pageGlobal = globalThis as Record<string, any>;
const originals = {
  capture: pageGlobal.__vexaGmeetCapture,
  admission: pageGlobal.__vexaAttributedAdmissionInstalled,
  stats: pageGlobal.__vexaAttributedAdmissionStats,
  per: pageGlobal.__vexaPerSpeakerAudioData,
  named: pageGlobal.__vexaNamedAudioData,
  overflow: pageGlobal.__vexaAttributedBoundaryOverflow,
  ready: pageGlobal.__vexaRemoteAudioReady,
  fetch: globalThis.fetch,
};
const requests: string[] = [];

const page = {
  async exposeFunction(name: string, fn: (...args: any[]) => unknown) { pageGlobal[name] = fn; },
  async evaluate(callback: (...args: any[]) => unknown, ...args: any[]) { return await callback(...args); },
};
const engine: BotPipeline = {
  async start() {}, async stop() {}, feedAudio() {}, feedMixedAudio() {}, recordHint() {},
  hintCounters: { received: 0, matched: 0, missed: 0 },
};
const invocation: Invocation = {
  platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Vexa',
  redisUrl: 'redis://localhost:6379', transcribeEnabled: false, attributedAudioEnabled: true,
  attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload', connectionId: 'capture-late-init-failure',
  meeting_id: 1, internalSecret: 'test-token',
};

try {
  // This is the capture object's post-start state after a late rescan's addModule() rejection.
  // startCaptureBridge must not treat it as a no-track/silent capture at teardown.
  pageGlobal.__vexaGmeetCapture = {
    stop() { throw new Error('gmeet capture worklet initialization failed'); },
    streamCount() { return 0; },
    resourceCounts() { return { contexts: 0, sources: 0, worklets: 0, tracks: 0, references: 0 }; },
  };
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0,
      state: 'open', ranges: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const faults: string[] = [];
  const live = createLivePipeline({
    startCapture: () => startCaptureBridge(page as any, invocation, engine),
    engine,
    captureFaultTerminal: true,
    onFault(stage) { faults.push(stage); },
  });
  await live.start();
  await assert.rejects(live.stop(), /gmeet capture worklet initialization failed/);
  assert.deepEqual(faults, ['capture-stop'], 'late capture failure becomes the terminal capture fault');
  assert.equal(requests.length, 1, `late initialization failure must not close an empty manifest: ${requests.join(', ')}`);
  assert.match(requests[0], /\/manifest\?/);
} finally {
  pageGlobal.__vexaGmeetCapture = originals.capture;
  pageGlobal.__vexaAttributedAdmissionInstalled = originals.admission;
  pageGlobal.__vexaAttributedAdmissionStats = originals.stats;
  pageGlobal.__vexaPerSpeakerAudioData = originals.per;
  pageGlobal.__vexaNamedAudioData = originals.named;
  pageGlobal.__vexaAttributedBoundaryOverflow = originals.overflow;
  pageGlobal.__vexaRemoteAudioReady = originals.ready;
  globalThis.fetch = originals.fetch;
}

console.log('late worklet initialization rejection fails terminal lifecycle before attributed close');
