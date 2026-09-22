import assert from 'node:assert/strict';
import { createAttributedAudioRecorder, createAttributedAudioSink } from './attributed-audio.js';

const uploaded: Array<{ range: any; bytes: Uint8Array }> = [];
const recorder = createAttributedAudioRecorder('m1', {
  put: async (range, bytes) => { uploaded.push({ range, bytes: bytes.slice() }); return { path: `/meetings/1/attributed-audio/ranges/${range.sequence}` }; },
  save: async () => {}, close: async () => {},
}, { cadenceMs: 5_000, gapMs: 10 });
// Interleaved channels retain independent turns; neither turn is fragmented at the other channel's frame.
await Promise.all([
  recorder.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: 'Alice', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([1]), capture_ms: 1_000, sample_rate: 1_000 }),
  recorder.feed({ channel: 1, speaker_key: 'channel:1', speaker_name: 'Bob', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([3]), capture_ms: 1_001, sample_rate: 1_000 }),
  recorder.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: 'Alice', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([2]), capture_ms: 1_004, sample_rate: 1_000 }),
]);
const manifest = await recorder.stop();
assert.deepEqual(uploaded.map(x => [x.range.channel, x.range.turn_generation, [...x.bytes]]), [
  [0, 1, [0, 0, 128, 63, 0, 0, 0, 64]], [1, 1, [0, 0, 64, 64]],
]);
assert.equal(manifest.clock_origin_ms, 1_000); assert.equal(manifest.ranges[0].start_ms, 0);
assert.equal(recorder.retainedBytes(), 0);

// A voiced but unbound frame is a ledger row with no invented name.
const unresolved: any[] = [];
const unresolvedRecorder = createAttributedAudioRecorder('m2', {
  put: async (range, bytes) => { unresolved.push({ range, bytes }); return { path: `/meetings/2/attributed-audio/ranges/${range.sequence}` }; }, save: async () => {}, close: async () => {},
}, { cadenceMs: 5_000 });
await unresolvedRecorder.feed({ channel: 4, speaker_key: 'channel:4', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array([1]), capture_ms: 10, sample_rate: 1_000 });
await unresolvedRecorder.stop();
assert.equal(unresolved[0].range.speaker_name, ''); assert.equal(unresolved[0].range.attribution.source, 'unresolved');

// Delayed upload + stop race: close admits no late callbacks and drains every retained byte.
let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
const delayed = createAttributedAudioRecorder('m3', { put: async (_range, _bytes) => { await gate; return { path: '/meetings/3/attributed-audio/ranges/0' }; }, save: async () => {}, close: async () => {} }, { cadenceMs: 5_000 });
await delayed.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: 'A', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([1]), capture_ms: 0, sample_rate: 1_000 });
const closing = delayed.stop();
await assert.rejects(() => delayed.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: 'A', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([2]), capture_ms: 4, sample_rate: 1_000 }), /stopped/);
release(); await closing; assert.equal(delayed.retainedBytes(), 0);

// An upload budget refusal is represented by a failed ledger row rather than a silent admitted drop.
const failures: any[] = [];
const bounded = createAttributedAudioSink('m4', { put: async () => { throw new Error('should not upload failed admission'); }, save: async m => { failures.push(m); }, close: async () => {} }, 8);
await assert.rejects(() => bounded.fail({ speaker_key: 'channel:0', speaker_name: '', channel: 0, turn_generation: 1, attribution: { source: 'unresolved', confidence: 0 }, clock_origin_ms: 0, start_ms: 0, end_ms: 1, codec: 'pcm_f32le', sample_rate: 1_000, channels: 1, byte_count: 4, sha256: '0'.repeat(64) }));
assert.equal((await bounded.close()).ranges[0].state, 'failed'); assert.ok(failures.length > 0);
console.log('attributed-audio capture ledger passes');
