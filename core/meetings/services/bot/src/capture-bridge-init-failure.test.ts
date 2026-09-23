import assert from 'node:assert/strict';
import { startCaptureBridge } from './capture-bridge.js';
import type { Invocation } from './config.js';
import type { BotPipeline } from './pipeline.js';

// This executes the serialized page callbacks through the real bridge.  The capture implementation
// separately proves that an AudioWorklet addModule rejection rejects start(); this seam proves that
// rejection reaches the attributed lifecycle instead of manufacturing a successful empty close.
const pageGlobal = globalThis as Record<string, any>;
const originals = {
  utils: pageGlobal.VexaBrowserUtils,
  capture: pageGlobal.__vexaGmeetCapture,
  speakers: pageGlobal.__vexaGmeetSpeakers,
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
  async exposeFunction(name: string, fn: (...args: any[]) => unknown) {
    pageGlobal[name] = fn;
  },
  async evaluate(callback: (...args: any[]) => unknown, ...args: any[]) {
    return await callback(...args);
  },
};

const pipeline: BotPipeline = {
  async start() {}, async stop() {}, feedAudio() {}, feedMixedAudio() {}, recordHint() {},
  hintCounters: { received: 0, matched: 0, missed: 0 },
};
const invocation: Invocation = {
  platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Vexa',
  redisUrl: 'redis://localhost:6379', transcribeEnabled: false, attributedAudioEnabled: true,
  attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload', connectionId: 'capture-init-failure',
  meeting_id: 1, internalSecret: 'test-token',
};

try {
  pageGlobal.VexaBrowserUtils = {
    createGmeetCapture: () => ({
      // Equivalent to createPcmCaptureNode rejecting audioWorklet.addModule().
      async start() { throw new Error('AudioWorklet addModule rejected'); },
      stop() {}, streamCount() { return 0; },
      resourceCounts() { return { contexts: 0, sources: 0, worklets: 0, tracks: 0, references: 0 }; },
    }),
  };
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0,
      state: 'open', ranges: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await assert.rejects(startCaptureBridge(page as any, invocation, pipeline), /attributed-audio capture start failed/);
  assert.equal(requests.length, 1, `initialization failure must not close an empty manifest: ${requests.join(', ')}`);
  assert.match(requests[0], /\/manifest\?/);
} finally {
  pageGlobal.VexaBrowserUtils = originals.utils;
  pageGlobal.__vexaGmeetCapture = originals.capture;
  pageGlobal.__vexaGmeetSpeakers = originals.speakers;
  pageGlobal.__vexaAttributedAdmissionInstalled = originals.admission;
  pageGlobal.__vexaAttributedAdmissionStats = originals.stats;
  pageGlobal.__vexaPerSpeakerAudioData = originals.per;
  pageGlobal.__vexaNamedAudioData = originals.named;
  pageGlobal.__vexaAttributedBoundaryOverflow = originals.overflow;
  pageGlobal.__vexaRemoteAudioReady = originals.ready;
  globalThis.fetch = originals.fetch;
}

console.log('AudioWorklet initialization rejection is terminal through the real capture bridge');
