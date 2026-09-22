import assert from 'node:assert/strict';
import { createAttributedAudioSink } from './attributed-audio.js';

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
