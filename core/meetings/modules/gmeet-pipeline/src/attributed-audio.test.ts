import assert from 'node:assert/strict';
import { createAttributedAudioSink } from './attributed-audio.js';

const stored: Uint8Array[] = [];
const sink = createAttributedAudioSink('m1', { put: async (_r, bytes) => { stored.push(bytes.slice()); return { url: 's3://evidence/0' }; }, close: async () => {} }, 64);
const range = await sink.seal({ speaker_key: 'ch-1:1', speaker_name: 'Alice', attribution: { source: 'glow-bound', confidence: .9 }, start_ms: 0, end_ms: 1000, codec: 'pcm_f32le', sample_rate: 16000, channels: 1 }, new Float32Array([1, 2]));
assert.equal(range.state, 'uploaded'); assert.equal(range.byte_count, 8); assert.equal(sink.bufferedBytes(), 0);
assert.equal((await sink.close()).state, 'closed'); assert.equal(stored.length, 1);
console.log('attributed-audio durable handoff passes');
