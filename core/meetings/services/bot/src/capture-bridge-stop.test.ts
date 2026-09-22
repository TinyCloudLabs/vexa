import assert from 'node:assert/strict';
import { startCaptureBridge } from './capture-bridge.js';
import type { Invocation } from './config.js';
import type { BotPipeline } from './pipeline.js';

const pageGlobal = globalThis as Record<string, unknown>;
const priorCapture = pageGlobal.__vexaGmeetCapture;
const priorFetch = globalThis.fetch;
let evaluations = 0;
const requests: string[] = [];

const page = {
  async exposeFunction() { /* bindings are not exercised by this teardown seam */ },
  async evaluate(callback: (...args: any[]) => unknown, ...args: any[]) {
    evaluations++;
    // The admission wrapper and page-side start are separate from this stop-only regression.
    if (evaluations === 3) return callback(...args);
    return undefined;
  },
};

const pipeline: BotPipeline = {
  async start() {}, async stop() {}, feedAudio() {}, feedMixedAudio() {}, recordHint() {},
  hintCounters: { received: 0, matched: 0, missed: 0 },
};

const invocation: Invocation = {
  platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Vexa',
  redisUrl: 'redis://localhost:6379', transcribeEnabled: false, attributedAudioEnabled: true,
  attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload', connectionId: 'capture-stop',
  meeting_id: 1, internalSecret: 'test-token',
};

try {
  pageGlobal.__vexaGmeetCapture = { stop: async () => { throw new Error('capture stop failed'); } };
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  const stop = await startCaptureBridge(page as any, invocation, pipeline);
  await assert.rejects(stop(), /capture stop failed/);
  assert.equal(requests.length, 1, `capture failure must not close attributed evidence: ${requests.join(', ')}`);
  assert.match(requests[0], /\/manifest\?/);
} finally {
  pageGlobal.__vexaGmeetCapture = priorCapture;
  globalThis.fetch = priorFetch;
}

console.log('capture stop rejection remains terminal and cannot close attributed evidence');
