import assert from 'node:assert/strict';
import { createAttributedAudioRecorder, type AttributedAudioManifest, type AttributedAudioRange, type AttributedAudioStore } from './attributed-audio.js';

const row = (range: any, state: AttributedAudioRange['state']) => ({ ...range, state });
function memoryStore(stall?: Promise<void>): AttributedAudioStore & { rows: AttributedAudioRange[]; uploaded: Uint8Array[] } {
  const rows: AttributedAudioRange[] = [], uploaded: Uint8Array[] = [];
  const find = (range: any) => rows.find(value => value.idempotency_key === range.idempotency_key)!;
  return {
    rows, uploaded,
    reserve: async range => { const prior = rows.find(value => value.idempotency_key === range.idempotency_key); if (prior) return structuredClone(prior); const value = row(range, 'sealed'); rows.push(value); return structuredClone(value); },
    upload: async (range, chunks) => { await stall; const value = find(range); value.state = 'uploaded'; value.path = `/meetings/1/attributed-audio/ranges/${range.sequence}`; uploaded.push(new Uint8Array(chunks.reduce((n, x) => n + x.byteLength, 0))); return { path: value.path }; },
    fail: async range => { const value = find(range); if (value.state !== 'uploaded') value.state = 'failed'; return structuredClone(value); },
    close: async () => {},
  };
}

const store = memoryStore();
const recorder = createAttributedAudioRecorder('m1', store, { cadenceMs: 5_000, gapMs: 10 });
await recorder.ready;
recorder.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: 'Alice', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([1]), capture_ms: 1_000, sample_rate: 1_000 });
recorder.feed({ channel: 1, speaker_key: 'channel:1', speaker_name: 'Bob', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([3]), capture_ms: 1_001, sample_rate: 1_000 });
recorder.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: 'Alice', attribution: { source: 'glow-bound', confidence: 1 }, pcm: new Float32Array([2]), capture_ms: 1_004, sample_rate: 1_000 });
const manifest = await recorder.stop();
assert.deepEqual(store.rows.map(x => [x.channel, x.turn_generation, x.audio_duration_ms]), [[0, 1, 2], [1, 1, 1]]);
assert.equal(manifest.clock_origin_ms, 1_000); assert.equal(manifest.ranges[0].start_ms, 0); assert.equal(recorder.retainedBytes(), 0);

// A stalled uploader cannot make admission closures, PCM, or metadata grow without bound.
let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
const stalledStore = memoryStore(gate), stalled = createAttributedAudioRecorder('m2', stalledStore, { cadenceMs: 5_000, budgetBytes: 64 });
await stalled.ready;
for (let index = 0; index < 200; index++) stalled.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(4), capture_ms: index * 4, sample_rate: 1_000 });
assert.ok(stalled.retainedBytes() <= 64); assert.ok(stalled.pendingTasks() <= 64); assert.ok(stalled.metadataCount() <= 65);
const stopping = stalled.stop(); release(); await stopping; assert.equal(stalled.retainedBytes(), 0);
assert.ok(stalledStore.rows.some(value => value.state === 'failed'), 'rejected voiced evidence is durably incomplete');

// Restart reconciliation retains the origin and turns a prior sealed reservation into a failure.
const recovered: AttributedAudioManifest = { version: 1, meeting_id: 'm3', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 7, state: 'open', ranges: [row({ version: 1, meeting_id: 'm3', sequence: 4, idempotency_key: 'old', speaker_key: 'channel:0', speaker_name: '', channel: 0, turn_generation: 3, attribution: { source: 'unresolved', confidence: 0 }, clock_origin_ms: 7, start_ms: 0, end_ms: 1, audio_duration_ms: 1, codec: 'pcm_f32le', sample_rate: 1000, channels: 1, byte_count: 4, sha256: '0'.repeat(64) }, 'sealed')] };
const restart = memoryStore(); restart.load = async () => structuredClone(recovered); restart.rows.push(...structuredClone(recovered.ranges));
const recreated = createAttributedAudioRecorder('m3', restart, { cadenceMs: 5_000 }); await recreated.ready;
recreated.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array([1]), capture_ms: 9, sample_rate: 1000 });
const closed = await recreated.stop(); assert.deepEqual(closed.ranges.map(value => [value.sequence, value.state]), [[4, 'failed'], [5, 'uploaded']]);
console.log('attributed-audio capture ledger passes');
