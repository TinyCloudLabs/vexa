/**
 * chunker.smoke — the MediaRecorder loop in isolation (no browser).
 *
 * record-chunker is the pure-logic recording brick: it wraps a MediaRecorder over
 * a combined audio stream and emits recording.v1 chunks (base64 + chunkSeq + isFinal
 * + mimeType). This test stubs the four browser globals it touches (MediaRecorder,
 * AudioContext-free path via direct MediaRecorderChunker, btoa, window/logBot) and
 * drives the REAL class to prove the contract the server reconciler depends on:
 *   1. chunkSeq increments monotonically from 0 across timeslice chunks;
 *   2. each chunk's base64 is the base64 of the blob body (round-trips);
 *   3. mimeType is the negotiated supported type;
 *   4. stop() emits exactly one extra chunk with isFinal=true (empty body OK)
 *      and resolves only AFTER that final onChunk completes.
 *
 * No assertion lib — same shape as mixed/pipeline's *.smoke.test.ts (tsx + exit code).
 */

// ── minimal browser-global stubs (installed before importing the brick) ─────────
const enc = (s: string): string => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).btoa = (s: string) => enc(s);
// the brick reads isTypeSupported off window.MediaRecorder, so the stub must live there too.
(globalThis as any).window = { logBot: (_m: string) => {} };

/** A fake Blob whose arrayBuffer() yields the bytes we seeded. */
class FakeBlob {
  constructor(private bytes: Uint8Array, private delayMs = 0) {}
  get size() { return this.bytes.length; }
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

/** A fake MediaRecorder that lets the test fire ondataavailable / stop on demand. */
class FakeMediaRecorder {
  static isTypeSupported(mime: string) { return mime === 'audio/webm;codecs=opus'; }
  onstart: (() => void) | null = null;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  pauseCalls = 0;
  mimeType: string;
  constructor(_stream: any, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? ''; }
  start(_timeslice?: number) { this.state = 'recording'; this.onstart?.(); }
  pause() { this.pauseCalls++; if (this.state === 'recording') this.state = 'paused'; }
  resume() { if (this.state === 'paused') this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  /** test helper — deliver a timeslice blob */
  emit(bytes: Uint8Array, delayMs = 0) { this.ondataavailable?.({ data: new FakeBlob(bytes, delayMs) }); }
}
(globalThis as any).MediaRecorder = FakeMediaRecorder;
(globalThis as any).window.MediaRecorder = FakeMediaRecorder; // brick reads window.MediaRecorder.isTypeSupported

// import AFTER globals exist (the module reads window/MediaRecorder lazily at runtime)
import { MediaRecorderChunker, type RecordingChunk } from './index';

const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  const got: RecordingChunk[] = [];
  let started = 0;
  const chunker = new MediaRecorderChunker({
    stream: {} as any, // unused by the FakeMediaRecorder
    timesliceMs: 1000,
    onChunk: async (c) => { got.push(c); return true; },
    onStarted: () => { started++; },
  });

  await chunker.start();
  const mr = chunker.getMediaRecorder() as unknown as FakeMediaRecorder;
  if (!mr) { console.log('❌ FAIL — start() did not create a MediaRecorder'); process.exit(1); }

  // two timeslice chunks with distinct bodies
  const body0 = new Uint8Array([1, 2, 3, 4, 250, 0, 127]);
  const body1 = new Uint8Array([9, 8, 7]);
  // A slow blob read must not let the next chunk or the completion marker overtake it.
  mr.emit(body0, 30);
  mr.emit(body1);

  await chunker.stop(); // → onstop → final chunk

  // ── assertions ────────────────────────────────────────────────────────────────
  const fails: string[] = [];
  if (started !== 1) fails.push(`onStarted fired ${started}× (want 1)`);
  if (got.length !== 3) fails.push(`emitted ${got.length} chunks (want 3: 2 data + 1 final)`);

  const [c0, c1, cF] = got;
  if (c0) {
    if (c0.chunkSeq !== 0) fails.push(`chunk0 seq=${c0.chunkSeq} (want 0)`);
    if (c0.isFinal) fails.push('chunk0 isFinal=true (want false)');
    if (!eqBytes(decode(c0.base64), body0)) fails.push('chunk0 base64 did not round-trip body0');
    if (c0.mimeType !== 'audio/webm;codecs=opus') fails.push(`chunk0 mimeType=${c0.mimeType} (want negotiated opus)`);
  }
  if (c1) {
    if (c1.chunkSeq !== 1) fails.push(`chunk1 seq=${c1.chunkSeq} (want 1)`);
    if (!eqBytes(decode(c1.base64), body1)) fails.push('chunk1 base64 did not round-trip body1');
  }
  if (cF) {
    if (cF.chunkSeq !== 2) fails.push(`final seq=${cF.chunkSeq} (want 2)`);
    if (!cF.isFinal) fails.push('final chunk isFinal=false (want true)');
    if (cF.base64 !== '') fails.push(`final chunk body=${JSON.stringify(cF.base64)} (want empty)`);
  }

  // A stalled bridge cannot turn MediaRecorder events into an unbounded promise chain. With a
  // 16-byte budget, one 8-byte blob is in flight, one is queued, and a third 1-byte blob overflows.
  // Terminal failure immediately releases the queued Blob while the active delivery may settle.
  let release: () => void = () => {};
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const boundedChunks: RecordingChunk[] = [];
  const bounded = new MediaRecorderChunker({
    stream: {} as any,
    maxPendingBytes: 16,
    onChunk: async (chunk) => { boundedChunks.push(chunk); await stalled; return true; },
  });
  await bounded.start();
  const boundedRecorder = bounded.getMediaRecorder() as unknown as FakeMediaRecorder;
  boundedRecorder.emit(new Uint8Array(8));
  await new Promise((resolve) => setTimeout(resolve, 0));
  boundedRecorder.emit(new Uint8Array(8));
  boundedRecorder.emit(new Uint8Array(1));
  const boundedDuringFailure = bounded.resourceCounts();
  let overflowRejected = false;
  try { await bounded.stop(); } catch { overflowRejected = true; }
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const boundedAfterSettled = bounded.resourceCounts();
  if (!overflowRejected ||
    boundedDuringFailure.retainedBytes !== 8 || boundedDuringFailure.queuedChunks !== 0 ||
    !boundedDuringFailure.processing || !boundedDuringFailure.failed ||
    boundedAfterSettled.retainedBytes !== 0 || boundedAfterSettled.queuedChunks !== 0 ||
    boundedAfterSettled.processing || !boundedAfterSettled.failed ||
    boundedChunks.some((chunk) => chunk.isFinal))
    fails.push(`overflow did not release queued Blobs atomically (${JSON.stringify({ boundedDuringFailure, boundedAfterSettled, chunks: boundedChunks.map((chunk) => ({ seq: chunk.chunkSeq, final: chunk.isFinal })), overflowRejected })})`);

  // Delayed acknowledgements must not turn each successful upload into a MediaRecorder pause.
  // Four 1-second content markers stand for a continuous four-second source; all are delivered
  // after the delayed bridge ACKs, proving the recording did not silently lose the paused gaps.
  const delayed: RecordingChunk[] = [];
  const continuous = new MediaRecorderChunker({
    stream: {} as any, maxPendingBytes: 128,
    onChunk: async (chunk) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      delayed.push(chunk);
      return true;
    },
  });
  await continuous.start();
  const continuousRecorder = continuous.getMediaRecorder() as unknown as FakeMediaRecorder;
  for (let second = 0; second < 4; second++) continuousRecorder.emit(new Uint8Array([second, 0x55]));
  await continuous.stop();
  const capturedSeconds = delayed.filter((chunk) => !chunk.isFinal).length;
  const contentPreserved = delayed.filter((chunk) => !chunk.isFinal)
    .every((chunk, i) => decode(chunk.base64)[0] === i && decode(chunk.base64)[1] === 0x55);
  if (continuousRecorder.pauseCalls !== 0 || capturedSeconds !== 4 || !contentPreserved)
    fails.push(`delayed ACK broke continuous capture (pause=${continuousRecorder.pauseCalls}, seconds=${capturedSeconds}, content=${contentPreserved})`);

  // A false acknowledgement of the completion signal is a producer failure, never a completed
  // recording. The page bridge uses this exact false return for a rejected final upload.
  const finalRejected = new MediaRecorderChunker({
    stream: {} as any,
    onChunk: async (chunk) => !chunk.isFinal,
  });
  await finalRejected.start();
  let finalRejectObserved = false;
  try { await finalRejected.stop(); } catch { finalRejectObserved = true; }
  if (!finalRejectObserved || !finalRejected.resourceCounts().failed)
    fails.push('false final acknowledgement did not fail the recording producer');

  // A requested recording whose MediaRecorder cannot be constructed must reject its start bridge;
  // returning success here would let the bot report a completed meeting with no recording.
  const originalRecorder = (globalThis as any).MediaRecorder;
  const originalWindowRecorder = (globalThis as any).window.MediaRecorder;
  class FailingMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { throw new Error('MediaRecorder unavailable'); }
  }
  (globalThis as any).MediaRecorder = FailingMediaRecorder;
  (globalThis as any).window.MediaRecorder = FailingMediaRecorder;
  let startRejected = false;
  try {
    await new MediaRecorderChunker({ stream: {} as any, onChunk: async () => true }).start();
  } catch (error) {
    startRejected = error instanceof Error && error.message === 'MediaRecorder unavailable';
  } finally {
    (globalThis as any).MediaRecorder = originalRecorder;
    (globalThis as any).window.MediaRecorder = originalWindowRecorder;
  }
  if (!startRejected) fails.push('MediaRecorder construction failure did not reject recording start');

  console.log(`chunks: ${JSON.stringify(got.map((c) => ({ seq: c.chunkSeq, final: c.isFinal, bytes: decode(c.base64).length })))}`);
  if (fails.length) {
    console.log('❌ FAIL — ' + fails.join('; '));
    process.exit(1);
  }
  console.log('✅ PASS — seq increments 0,1, bodies round-trip base64, final chunk isFinal=true(empty), mimeType negotiated');
  process.exit(0);
}

main().catch((e) => { console.error('❌ FAIL —', e?.message || e); process.exit(1); });
