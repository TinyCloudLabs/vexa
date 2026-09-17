/**
 * Regression gate for the production empty-transcript failure:
 *   - completed channel turns must outlive a slow STT response;
 *   - one bot must obey its configured STT concurrency and live-draft budget;
 *   - dispose must wait for every queued turn and finalize exactly once.
 *
 * The old lane deleted a closed turn after a fixed 12 seconds while its request could
 * legitimately take 30 seconds. This test accelerates that cleanup timer so the race is
 * deterministic without making CI sleep for 12 seconds.
 */
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { createGmeetPipeline, type TranscriptSegment, type TranscriptSink } from './index.js';
import type { TranscriptionResult } from '@vexa/transcribe-whisper';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

interface PendingRequest {
  marker: number;
  resolve: (result: TranscriptionResult) => void;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await delay(1);
  if (!condition()) throw new Error('timed out waiting for the transcription scheduler');
}

async function run() {
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 12_000) {
      queueMicrotask(() => fn(...args));
      return { unref() {} };
    }
    return realSetTimeout(fn as never, delay, ...args as never[]);
  }) as typeof setTimeout;

  try {
    const pending: PendingRequest[] = [];
    const segments: TranscriptSegment[] = [];
    let active = 0;
    let maxActive = 0;
    let finalized = 0;

    const transcribe = (pcm: Float32Array): Promise<TranscriptionResult> => {
      const marker = Math.round(pcm[0] * 100);
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => pending.push({
        marker,
        resolve: (result) => { active--; resolve(result); },
      }));
    };
    const sink: TranscriptSink = {
      segment: (segment) => segments.push(segment),
      draft: () => {},
      finalize: () => { finalized++; },
    };
    const pipe = createGmeetPipeline({
      transcribe, sink, maxConcurrentTranscriptions: 1, maxPendingTranscriptions: 4,
    });
    const oneSecond = (marker: number) => new Float32Array(16_000).fill(marker / 100);

    // Four turns on one reused channel. Every gap closes the previous turn and submits it.
    pipe.feedAudio(0, 'Alice', oneSecond(1), 0);
    pipe.feedAudio(0, 'Bob', oneSecond(2), 2_500);
    pipe.feedAudio(0, 'Carol', oneSecond(3), 5_000);
    pipe.feedAudio(0, 'Dana', oneSecond(4), 7_500);
    const disposing = pipe.dispose();

    // Resolve in scheduler order. A bounded lane starts the next request only after the current one
    // settles; the old lane starts all four immediately and loses the first three to fixed cleanup.
    for (let completed = 0; completed < 4; completed++) {
      await waitFor(() => pending.length > 0);
      const request = pending.shift()!;
      const text = `recorded marker number ${request.marker} successfully`;
      request.resolve({
        text,
        language: 'en',
        language_probability: 1,
        duration: 1,
        segments: [{ start: 0, end: 1, text }],
      });
      await tick();
    }
    await disposing;

    check('one bot executes at most one STT request at a time', maxActive === 1, `maxActive=${maxActive}`);
    check('every delayed closed turn reaches the confirmed transcript',
      segments.map((segment) => segment.text).sort().join(',') === [1, 2, 3, 4]
        .map((marker) => `recorded marker number ${marker} successfully`).sort().join(','),
      JSON.stringify(segments.map((segment) => segment.text)));
    check('dispose finalizes the transcript exactly once', finalized === 1, `finalized=${finalized}`);

    // Meeting teardown has only one request horizon. If audio was appended after a live snapshot,
    // start exactly one full-window terminal request immediately (with its bounded terminal
    // allowance), let it finish before the old draft, and ignore that stale draft's late result.
    {
      const faults: unknown[] = [];
      const tailSegments: TranscriptSegment[] = [];
      const starts: number[] = [];
      const sampleCounts: number[] = [];
      let activeTailRequests = 0;
      let maxActiveTailRequests = 0;
      let tailFinalized = 0;
      const tailPipe = createGmeetPipeline({
        maxConcurrentTranscriptions: 1,
        maxPendingTranscriptions: 1,
        config: { submitInterval: 0.001 },
        transcribe: (pcm) => {
          const call = starts.length;
          starts.push(Date.now());
          sampleCounts.push(pcm.length);
          activeTailRequests++;
          maxActiveTailRequests = Math.max(maxActiveTailRequests, activeTailRequests);
          const text = call === 0 ? 'incomplete first response' : 'complete three second response';
          return new Promise<TranscriptionResult>((resolve) => realSetTimeout(() => {
            activeTailRequests--;
            resolve({ text, language: 'en', language_probability: 1, duration: call === 0 ? 2 : 3,
              segments: [{ start: 0, end: call === 0 ? 2 : 3, text }] });
          }, call === 0 ? 80 : 20));
        },
        sink: {
          segment: (segment) => tailSegments.push(segment),
          finalize: () => { tailFinalized++; },
        },
        onError: (fault) => faults.push(fault),
      });
      tailPipe.feedAudio(0, 'Alice', new Float32Array(2 * 16_000).fill(0.1), 0);
      await waitFor(() => starts.length === 1);
      tailPipe.feedAudio(0, 'Alice', oneSecond(1), 500);
      const disposeStartedAt = Date.now();
      const tailDisposing = tailPipe.dispose();
      await waitFor(() => starts.length === 2);
      await tailDisposing;
      const disposeElapsedMs = Date.now() - disposeStartedAt;

      check('terminal replacement starts immediately despite a saturated ordinary budget',
        sampleCounts.join(',') === `${2 * 16_000},${3 * 16_000}` &&
        starts[1] - starts[0] < 40 && maxActiveTailRequests === 2 && faults.length === 0,
        JSON.stringify({ sampleCounts, startGap: starts[1] - starts[0], maxActiveTailRequests, faults: faults.length }));
      check('terminal replacement publishes the complete tail and ignores the stale draft',
        tailSegments.map((segment) => segment.text).join(',') === 'complete three second response',
        JSON.stringify(tailSegments.map((segment) => segment.text)));
      check('tail teardown fits one request horizon and finalizes exactly once',
        disposeElapsedMs < 120 && tailFinalized === 1,
        JSON.stringify({ disposeElapsedMs, tailFinalized }));
    }

    // A live-draft budget must never become a closed-turn deletion policy. Even with room for only
    // two ordinary snapshots, all four completed turns are durable FIFO work and must survive.
    {
      const backlog: PendingRequest[] = [];
      const started: number[] = [];
      const faults: unknown[] = [];
      const kept: TranscriptSegment[] = [];
      let breakerFinalized = 0;
      const breaker = createGmeetPipeline({
        maxConcurrentTranscriptions: 1,
        maxPendingTranscriptions: 2,
        transcribe: (pcm) => {
          const marker = Math.round(pcm[0] * 100);
          started.push(marker);
          return new Promise((resolve) => backlog.push({ marker, resolve }));
        },
        sink: {
          segment: (segment) => kept.push(segment),
          finalize: () => { breakerFinalized++; },
        },
        onError: (fault) => faults.push(fault),
      });
      breaker.feedAudio(0, 'Alice', oneSecond(1), 0);
      breaker.feedAudio(0, 'Bob', oneSecond(2), 2_500);
      breaker.feedAudio(0, 'Carol', oneSecond(3), 5_000);
      breaker.feedAudio(0, 'Dana', oneSecond(4), 7_500);
      const breakerDispose = breaker.dispose();

      for (let completed = 0; completed < 4; completed++) {
        await waitFor(() => backlog.length > 0);
        const request = backlog.shift()!;
        const text = `kept marker ${request.marker}`;
        request.resolve({ text, language: 'en', language_probability: 1, duration: 1,
          segments: [{ start: 0, end: 1, text }] });
        await tick();
      }
      await breakerDispose;

      check('closed turns ignore the live-draft budget and execute one at a time in FIFO order',
        started.join(',') === '1,2,3,4', JSON.stringify(started));
      check('ordinary closed-turn backlog is not reported as overload',
        faults.length === 0, JSON.stringify(faults));
      check('every closed turn is retained and dispose still finalizes',
        kept.map((segment) => segment.text).join(',') ===
          'kept marker 1,kept marker 2,kept marker 3,kept marker 4' && breakerFinalized === 1,
        JSON.stringify({ kept: kept.map((segment) => segment.text), breakerFinalized }));
    }


    // Production defaults serialize CPU Whisper work but retain a realistic burst of closed turns.
    // Parallel requests reduce throughput on this deployment; queueing is the backpressure.
    {
      const pending: PendingRequest[] = [];
      const faults: unknown[] = [];
      let active = 0;
      let maxActive = 0;
      const defaultPipe = createGmeetPipeline({
        transcribe: (pcm) => {
          active++;
          maxActive = Math.max(maxActive, active);
          return new Promise((resolve) => pending.push({
            marker: Math.round(pcm[0] * 100),
            resolve: (result) => { active--; resolve(result); },
          }));
        },
        sink: { segment: () => {}, finalize: () => {} },
        onError: (fault) => faults.push(fault),
      });
      for (let marker = 1; marker <= 8; marker++) {
        defaultPipe.feedAudio(0, `Speaker ${marker}`, oneSecond(marker), (marker - 1) * 2_500);
      }
      const defaultDispose = defaultPipe.dispose();
      const completed: number[] = [];
      while (completed.length < 8) {
        await waitFor(() => pending.length > 0);
        const request = pending.shift()!;
        completed.push(request.marker);
        const text = `default marker ${request.marker}`;
        request.resolve({ text, language: 'en', language_probability: 1, duration: 1,
          segments: [{ start: 0, end: 1, text }] });
        await tick();
      }
      await defaultDispose;
      check('production defaults serialize and preserve a closed-turn burst',
        completed.join(',') === '1,2,3,4,5,6,7,8' && maxActive === 1 && faults.length === 0,
        JSON.stringify({ completed, maxActive, faults: faults.length }));
    }

    // A timed-out HTTP client does not prove server-side inference stopped. Hold the scheduler for
    // one recovery horizon before reusing its slot, then resume rather than disabling the rest of
    // a long meeting permanently.
    {
      let calls = 0;
      let serverActive = 0;
      let maxServerActive = 0;
      let timeoutFinalized = 0;
      const faults: unknown[] = [];
      const resumedSegments: TranscriptSegment[] = [];
      const timeoutPipe = createGmeetPipeline({
        maxConcurrentTranscriptions: 1,
        maxPendingTranscriptions: 4,
        timeoutRecoveryDelayMs: 10,
        transcribe: async (pcm) => {
          calls++;
          serverActive++;
          maxServerActive = Math.max(maxServerActive, serverActive);
          if (calls === 1) {
            realSetTimeout(() => { serverActive--; }, 5);
            throw Object.assign(new Error('request timed out'), { source: 'stt', kind: 'timeout', retryable: false });
          }
          const marker = Math.round(pcm[0] * 100);
          const text = `resumed marker ${marker}`;
          serverActive--;
          return { text, language: 'en', language_probability: 1, duration: 1,
            segments: [{ start: 0, end: 1, text }] };
        },
        sink: { segment: (segment) => resumedSegments.push(segment), finalize: () => { timeoutFinalized++; } },
        onError: (fault) => faults.push(fault),
      });
      timeoutPipe.feedAudio(0, 'Alice', oneSecond(1), 0);
      timeoutPipe.feedAudio(0, 'Bob', oneSecond(2), 2_500);
      timeoutPipe.feedAudio(0, 'Carol', oneSecond(3), 5_000);
      timeoutPipe.feedAudio(0, 'Dana', oneSecond(4), 7_500);
      await timeoutPipe.flush();
      await timeoutPipe.dispose();

      check('timeout cooldown prevents client slot reuse while orphaned server work is active',
        maxServerActive === 1, `maxServerActive=${maxServerActive}`);
      check('timeout cooldown reports the original timeout and later transcription resumes',
        calls === 4 && faults.filter((fault) => (fault as { kind?: string }).kind === 'timeout').length === 1 &&
        resumedSegments.map((segment) => segment.text).join(',') === 'resumed marker 2,resumed marker 3,resumed marker 4',
        JSON.stringify(faults.map((fault) => (fault as { kind?: string }).kind)));
      check('timeout recovery drains all queued turns and finalizes without a teardown wedge',
        timeoutFinalized === 1, `finalized=${timeoutFinalized}`);
    }

    // With multiple allowed callers, a later timeout extends the cooldown seen by an earlier
    // waiter. The waiter must recheck after waking instead of starting against the later orphan.
    {
      const rejectors: Array<(error: unknown) => void> = [];
      let calls = 0;
      let orphanedServerWork = 0;
      let resumedDuringOrphan = false;
      const multiTimeoutPipe = createGmeetPipeline({
        maxConcurrentTranscriptions: 2,
        maxPendingTranscriptions: 4,
        timeoutRecoveryDelayMs: 20,
        transcribe: async (pcm) => {
          calls++;
          if (calls <= 2) {
            orphanedServerWork++;
            return new Promise<TranscriptionResult>((_resolve, reject) => rejectors.push(reject));
          }
          if (orphanedServerWork > 0) resumedDuringOrphan = true;
          const marker = Math.round(pcm[0] * 100);
          const text = `recovered marker ${marker}`;
          return { text, language: 'en', language_probability: 1, duration: 1,
            segments: [{ start: 0, end: 1, text }] };
        },
        sink: { segment: () => {}, finalize: () => {} },
        onError: () => {},
      });
      multiTimeoutPipe.feedAudio(0, 'Alice', oneSecond(1), 0);
      multiTimeoutPipe.feedAudio(0, 'Bob', oneSecond(2), 2_500);
      multiTimeoutPipe.feedAudio(0, 'Carol', oneSecond(3), 5_000);
      multiTimeoutPipe.feedAudio(0, 'Dana', oneSecond(4), 7_500);
      const multiFlush = multiTimeoutPipe.flush();
      await waitFor(() => rejectors.length === 2);
      rejectors[0](Object.assign(new Error('first timeout'), { kind: 'timeout' }));
      realSetTimeout(() => { orphanedServerWork--; }, 15);
      await new Promise((resolve) => realSetTimeout(resolve, 8));
      rejectors[1](Object.assign(new Error('later timeout'), { kind: 'timeout' }));
      realSetTimeout(() => { orphanedServerWork--; }, 15);
      await multiFlush;
      await multiTimeoutPipe.dispose();

      check('a later concurrent timeout extends sleeping waiters before STT resumes',
        calls === 4 && !resumedDuringOrphan,
        JSON.stringify({ calls, resumedDuringOrphan, orphanedServerWork }));
    }

    // Teardown must not retain a cooldown sleeper and then begin a fresh 30-second request after
    // the cooldown. Once dispose starts, queued recovery work fails loudly and the accepted work
    // remains bounded by the request already in progress.
    {
      const rejectors: Array<(error: unknown) => void> = [];
      const faults: unknown[] = [];
      let calls = 0;
      let finalized = 0;
      const teardownPipe = createGmeetPipeline({
        maxConcurrentTranscriptions: 1,
        maxPendingTranscriptions: 2,
        timeoutRecoveryDelayMs: 100,
        transcribe: async () => {
          calls++;
          return new Promise<TranscriptionResult>((_resolve, reject) => rejectors.push(reject));
        },
        sink: { segment: () => {}, finalize: () => { finalized++; } },
        onError: (fault) => faults.push(fault),
      });
      teardownPipe.feedAudio(0, 'Alice', oneSecond(1), 0);
      teardownPipe.feedAudio(0, 'Bob', oneSecond(2), 2_500);
      await waitFor(() => rejectors.length === 1);
      const teardown = teardownPipe.dispose();
      const timeoutAt = Date.now();
      rejectors[0](Object.assign(new Error('timeout at teardown'), { source: 'stt', kind: 'timeout' }));
      await teardown;

      check('dispose interrupts timeout cooldown instead of starting another request after it',
        calls === 1 && Date.now() - timeoutAt < 50,
        JSON.stringify({ calls, elapsed: Date.now() - timeoutAt }));
      check('dispose reports the timeout and refused recovery, then finalizes exactly once',
        faults.some((fault) => (fault as { kind?: string }).kind === 'timeout') &&
        faults.some((fault) => (fault as { kind?: string }).kind === 'overloaded') && finalized === 1,
        JSON.stringify({ faults: faults.map((fault) => (fault as { kind?: string }).kind), finalized }));
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  if (failed) {
    console.error(`\n❌ transcription-backpressure: ${failed} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\n✅ transcription-backpressure: slow closed turns survive, scheduling is bounded, and dispose is single-shot.');
}

run().catch((error) => { console.error(error); process.exit(1); });
