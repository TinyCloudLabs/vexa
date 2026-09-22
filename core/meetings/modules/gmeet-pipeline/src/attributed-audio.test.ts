import assert from 'node:assert/strict';
import { createAttributedAudioSink, createAttributedAudioRecorder, DEFAULT_PCM_BUDGET_BYTES } from './attributed-audio.js';

const stored: Uint8Array[] = [];
const snapshots: unknown[] = [];
const sink = createAttributedAudioSink('m1', { put: async (_r, bytes) => { stored.push(bytes.slice()); return { url: '/attributed-audio/m1/0' }; }, save: async manifest => { snapshots.push(manifest); }, close: async () => {} }, 64);
const range = await sink.seal({ speaker_key: 'ch-1:1', speaker_name: 'Alice', attribution: { source: 'glow-bound', confidence: .9 }, start_ms: 0, end_ms: 1000, codec: 'pcm_f32le', sample_rate: 16000, channels: 1 }, new Float32Array([1, 2]));
assert.equal(range.state, 'uploaded'); assert.equal(range.byte_count, 8); assert.equal(sink.bufferedBytes(), 0);
assert.equal((await sink.close()).state, 'closed'); assert.equal(stored.length, 1);
assert.ok(snapshots.length >= 3, 'reserve, upload, and close are durably recorded');

let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const concurrent = createAttributedAudioSink('m2', {
  put: async (r) => { await gate; return { url: `/attributed-audio/m2/${r.sequence}` }; },
  save: async () => {}, close: async () => {},
});
const input = { speaker_key: 'ch', speaker_name: 'Bob', attribution: { source: 'glow-bound' as const, confidence: 1 }, start_ms: 0, end_ms: 1, codec: 'pcm_f32le' as const, sample_rate: 16000, channels: 1 as const };
const first = concurrent.seal({ ...input, idempotency_key: 'same' }, new Float32Array([1]));
const same = concurrent.seal({ ...input, idempotency_key: 'same' }, new Float32Array([1]));
const other = concurrent.seal({ ...input, start_ms: 1, end_ms: 2 }, new Float32Array([1]));
release();
const [a, b, c] = await Promise.all([first, same, other]);
assert.deepEqual([a.sequence, b.sequence, c.sequence], [0, 0, 1]);
assert.deepEqual((await concurrent.close()).ranges.map(r => r.sequence), [0, 1]);
console.log('attributed-audio durable handoff passes');

const captured: Array<{ range: any; bytes: Uint8Array }> = [];
const recorder = createAttributedAudioRecorder('m3', {
  put: async (range, bytes) => { captured.push({ range, bytes: bytes.slice() }); return { path: `/meetings/3/attributed-audio/ranges/${range.sequence}` }; },
  save: async () => {}, close: async () => {},
}, { cadenceMs: 5_000 });
// Interleaving Alice/Bob forces an identity seal; no transcriber is supplied to this producer.
await recorder.feed({ channel: 0, speaker_key: 'gmeet:0:Alice', speaker_name: 'Alice', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([1, 2]), capture_ms: 1000, sample_rate: 16000 });
await recorder.feed({ channel: 1, speaker_key: 'gmeet:1:Bob', speaker_name: 'Bob', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([3, 4]), capture_ms: 1001, sample_rate: 16000 });
const closed = await recorder.stop();
assert.deepEqual(captured.map(x => [x.range.sequence, x.range.speaker_name, [...x.bytes]]), [[0, 'Alice', [0, 0, 128, 63, 0, 0, 0, 64]], [1, 'Bob', [0, 0, 64, 64, 0, 0, 128, 64]]]);
assert.equal(closed.clock_origin, 'capture_epoch_ms');
assert.equal(closed.state, 'closed'); assert.equal(recorder.retainedBytes(), 0);

let allowUpload!: () => void;
const slow = new Promise<void>(resolve => { allowUpload = resolve; });
const bounded = createAttributedAudioRecorder('m4', {
  put: async () => { await slow; return { path: '/meetings/4/attributed-audio/ranges/0' }; }, save: async () => {}, close: async () => {},
}, { cadenceMs: 5_000, budgetBytes: 16 });
await bounded.feed({ channel: 0, speaker_key: 'a', speaker_name: 'A', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([1, 2, 3, 4]), capture_ms: 0, sample_rate: 1 });
await assert.rejects(() => bounded.feed({ channel: 0, speaker_key: 'a', speaker_name: 'A', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([5]), capture_ms: 4, sample_rate: 1 }), /budget/);
const drain = bounded.stop(); allowUpload(); await drain; assert.ok(DEFAULT_PCM_BUDGET_BYTES >= 16);
