import assert from 'node:assert/strict';
import { installPageAttributedAudioAdmission, PAGE_ATTRIBUTED_AUDIO_MAX_BYTES, PAGE_ATTRIBUTED_AUDIO_MAX_CALLS } from './capture-bridge.js';

const page = globalThis as any;
const original = {
  per: page.__vexaPerSpeakerAudioData, named: page.__vexaNamedAudioData,
  overflow: page.__vexaAttributedBoundaryOverflow, capture: page.__vexaGmeetCapture,
  installed: page.__vexaAttributedAdmissionInstalled, stats: page.__vexaAttributedAdmissionStats,
};
try {
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, overflows = 0, stopped = 0;
  page.__vexaPerSpeakerAudioData = async () => { calls++; await stalled; };
  page.__vexaNamedAudioData = page.__vexaPerSpeakerAudioData;
  page.__vexaAttributedBoundaryOverflow = async () => { overflows++; };
  page.__vexaGmeetCapture = { stop: () => { stopped++; } };
  delete page.__vexaAttributedAdmissionInstalled;
  installPageAttributedAudioAdmission({ maxBytes: PAGE_ATTRIBUTED_AUDIO_MAX_BYTES, maxCalls: PAGE_ATTRIBUTED_AUDIO_MAX_CALLS });

  // 2,200 stalled calls used to leave >36MiB in Chromium.  The exact page-side gate admits only
  // its bounded count (and bytes), then reports one durable-overflow callback and stops capture.
  const pcm = new Array(1_024).fill(0); // 4KiB each: count, not bytes, is the limiting dimension.
  for (let index = 0; index < 2_200; index++) void page.__vexaPerSpeakerAudioData(0, pcm, index);
  assert.equal(calls, PAGE_ATTRIBUTED_AUDIO_MAX_CALLS);
  assert.equal(page.__vexaAttributedAdmissionStats().calls, PAGE_ATTRIBUTED_AUDIO_MAX_CALLS);
  assert.ok(page.__vexaAttributedAdmissionStats().bytes <= PAGE_ATTRIBUTED_AUDIO_MAX_BYTES);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(overflows, 1); assert.equal(stopped, 1);

  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.__vexaAttributedAdmissionStats(), { bytes: 0, calls: 0, stopped: true });

  // Byte admission is independent of call admission: exactly-at-cap frames are retained, the next
  // callback is refused before it reaches Node, and teardown observes/reclaims both reservations.
  let releaseBytes!: () => void; const byteStall = new Promise<void>(resolve => { releaseBytes = resolve; });
  calls = 0; overflows = 0; stopped = 0;
  page.__vexaPerSpeakerAudioData = async () => { calls++; await byteStall; };
  page.__vexaNamedAudioData = page.__vexaPerSpeakerAudioData;
  delete page.__vexaAttributedAdmissionInstalled;
  installPageAttributedAudioAdmission({ maxBytes: 16, maxCalls: 10 });
  void page.__vexaPerSpeakerAudioData(0, [0, 0], 1); // 8 bytes, below cap
  void page.__vexaPerSpeakerAudioData(0, [0, 0], 2); // exactly at cap
  void page.__vexaPerSpeakerAudioData(0, [0, 0], 3); // above cap
  assert.equal(calls, 2); assert.deepEqual(page.__vexaAttributedAdmissionStats(), { bytes: 16, calls: 2, stopped: true });
  releaseBytes(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.__vexaAttributedAdmissionStats(), { bytes: 0, calls: 0, stopped: true });
} finally {
  page.__vexaPerSpeakerAudioData = original.per; page.__vexaNamedAudioData = original.named;
  page.__vexaAttributedBoundaryOverflow = original.overflow; page.__vexaGmeetCapture = original.capture;
  page.__vexaAttributedAdmissionInstalled = original.installed; page.__vexaAttributedAdmissionStats = original.stats;
}
console.log('page-side attributed admission bounds stalled bindings and releases after settle');
