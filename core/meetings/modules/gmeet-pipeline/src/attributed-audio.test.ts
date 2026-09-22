import assert from 'node:assert/strict';
import { createAttributedAudioRecorder, createAttributedAudioSink, type AttributedAudioManifest, type AttributedAudioRange, type AttributedAudioStore } from './attributed-audio.js';

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

// Historical rows are evidence, not a concurrency budget. 65 five-second ranges and a
// three-hour-equivalent ledger must both close without a silent tail drop.
for (const count of [65, 3 * 60 * 60 / 5]) {
  const historyStore = memoryStore();
  const history = createAttributedAudioSink(`history-${count}`, historyStore, 64 * 1024);
  for (let sequence = 0; sequence < count; sequence++) {
    await history.seal({ speaker_key: 'channel:0', speaker_name: '', channel: 0, turn_generation: sequence + 1,
      attribution: { source: 'unresolved', confidence: 0 }, start_ms: sequence * 5_000, end_ms: (sequence + 1) * 5_000,
      codec: 'pcm_f32le', sample_rate: 250, channels: 1 }, [new Float32Array(1_250)]);
  }
  const historyManifest = await history.close();
  assert.equal(historyManifest.ranges.length, count);
  assert.deepEqual(historyManifest.ranges.map(range => range.sequence), Array.from({ length: count }, (_, index) => index));
}

// A callback clock commonly jitters by a few milliseconds. Sample duration remains authoritative:
// 4096 @16kHz twice is 512ms audio even though its wall span is 506ms.
const jitter = createAttributedAudioRecorder('jitter', memoryStore(), { cadenceMs: 5_000 });
await jitter.ready;
jitter.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(4096), capture_ms: 1_000, sample_rate: 16_000 });
jitter.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(4096), capture_ms: 1_250, sample_rate: 16_000 });
const jitterManifest = await jitter.stop();
assert.equal(jitterManifest.ranges[0].audio_duration_ms, 512);
assert.equal(jitterManifest.ranges[0].end_ms, 506);

// Rejected audio is split into valid durable missing rows instead of creating one metadata body
// too large for the server validator (4 MiB + 4 MiB + two samples with a four-byte PCM budget).
const missingStore = memoryStore();
const missing = createAttributedAudioRecorder('missing', missingStore, { cadenceMs: 5_000, budgetBytes: 4 });
await missing.ready;
let missingClock = 1_000;
for (const samples of [4_194_304, 4_194_304, 2]) {
  missing.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(samples), capture_ms: missingClock, sample_rate: 16_000 });
  missingClock += samples / 16;
}
const missingManifest = await missing.stop();
assert.ok(missingManifest.ranges.every(range => range.byte_count <= 32 * 1024 * 1024));
assert.ok(missingManifest.ranges.every(range => range.state === 'failed'), JSON.stringify(missingManifest.ranges));
assert.equal(missingManifest.state, 'closed');
console.log('attributed-audio capture ledger passes');
