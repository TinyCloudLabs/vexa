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

// Bytes alone are not a concurrency bound: tiny ranges separated by capture gaps previously made
// one stalled storage promise per callback. Admission rejects before allocating a third task.
let releaseTasks!: () => void; const taskGate = new Promise<void>(resolve => { releaseTasks = resolve; });
const taskStore = memoryStore(taskGate), taskBound = createAttributedAudioSink('task-bound', taskStore, 1024, 2);
const tiny = (sequence: number) => ({ idempotency_key: `tiny-${sequence}`, speaker_key: 'channel:0', speaker_name: '', channel: 0,
  turn_generation: sequence + 1, attribution: { source: 'unresolved' as const, confidence: 0 }, start_ms: sequence, end_ms: sequence + 1,
  codec: 'pcm_f32le' as const, sample_rate: 1_000, channels: 1 as const });
const p0 = taskBound.seal(tiny(0), [new Float32Array(1)]), p1 = taskBound.seal(tiny(1), [new Float32Array(1)]);
assert.equal(taskBound.taskCount(), 2);
assert.throws(() => taskBound.seal(tiny(2), [new Float32Array(1)]), /storage task admission exhausted/);
releaseTasks(); await Promise.all([p0, p1]);
assert.equal(taskBound.taskCount(), 0, 'settled task closures are compacted after durable accounting');

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
  assert.equal(history.taskCount(), 0, 'settled historical ranges do not retain task state');
  assert.equal(history.retainedMetadataCount(), count, 'telemetry counts the one retained manifest collection');
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

// The published 250ms whole-range clock/sample delta is shared with the route validator.  1250
// and 1300 remain one truthful range; a third 1600 callback would accumulate 400ms and splits.
for (const [captureMs, expected] of [[1_250, [[0, 350, 200]]], [1_300, [[0, 400, 200]]], [1_600, [[0, 100, 100], [600, 700, 100]]]] as const) {
  const control = createAttributedAudioRecorder(`gap-${captureMs}`, memoryStore(), { cadenceMs: 5_000 });
  await control.ready;
  control.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(100), capture_ms: 1_000, sample_rate: 1_000 });
  control.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(100), capture_ms: captureMs, sample_rate: 1_000 });
  const controlManifest = await control.stop();
  assert.deepEqual(controlManifest.ranges.map(range => [range.start_ms, range.end_ms, range.audio_duration_ms]), expected);
  assert.equal(controlManifest.state, 'closed');
}

// Longer adjacent scheduling gaps keep each emitted range inside the same published bound.
const cumulative = createAttributedAudioRecorder('cumulative-gap', memoryStore(), { cadenceMs: 5_000 });
await cumulative.ready;
for (const capture_ms of [1_000, 1_300, 1_600, 1_900, 2_200]) {
  cumulative.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(100), capture_ms, sample_rate: 1_000 });
}
assert.deepEqual((await cumulative.stop()).ranges.map(range => [range.start_ms, range.end_ms, range.audio_duration_ms]), [[0, 400, 200], [600, 1_000, 200], [1_200, 1_300, 100]]);

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

// Rejected frames separated by silence must split just like PCM frames. Their wall spans now match
// the sample clock, so reserve and close receive two valid missing rows rather than one 1.1s lie.
const missingGap = createAttributedAudioRecorder('missing-gap', memoryStore(), { cadenceMs: 5_000, budgetBytes: 0 });
await missingGap.ready;
missingGap.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(100), capture_ms: 1_000, sample_rate: 1_000 });
missingGap.feed({ channel: 0, speaker_key: 'channel:0', speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(100), capture_ms: 2_000, sample_rate: 1_000 });
const missingGapManifest = await missingGap.stop();
assert.deepEqual(missingGapManifest.ranges.map(range => [range.start_ms, range.end_ms, range.audio_duration_ms, range.state]),
  [[0, 100, 100, 'failed'], [1000, 1100, 100, 'failed']]);

// Same-key retries compare before sequence allocation: pending and completed retries receive the
// exact original promise/receipt, while a changed immutable payload is rejected.
let openGate!: () => void; const pendingGate = new Promise<void>(resolve => { openGate = resolve; });
const idemStore = memoryStore(pendingGate), idem = createAttributedAudioSink('idem', idemStore);
const idemInput = { idempotency_key: 'same', speaker_key: 'channel:0', speaker_name: '', channel: 0, turn_generation: 1,
  attribution: { source: 'unresolved' as const, confidence: 0 }, start_ms: 0, end_ms: 1, codec: 'pcm_f32le' as const, sample_rate: 1_000, channels: 1 as const };
const first = idem.seal(idemInput, [new Float32Array([1])]);
const pendingRetry = idem.seal(idemInput, [new Float32Array([1])]);
assert.equal(first, pendingRetry); assert.equal(idem.manifest().ranges[0].sequence, 0);
assert.throws(() => idem.seal({ ...idemInput, end_ms: 2 }, [new Float32Array([1])]), /conflicts/);
openGate(); await first;
const completeRetry = await idem.seal(idemInput, [new Float32Array([1])]);
assert.equal(completeRetry.sequence, 0); assert.equal(idem.manifest().ranges.length, 1);
assert.throws(() => idem.seal({ ...idemInput, speaker_key: 'changed' }, [new Float32Array([1])]), /conflicts/);
console.log('attributed-audio capture ledger passes');
