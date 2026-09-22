/**
 * gmeet-pipeline — Google Meet CHANNEL-routed strategy (overlap-safe).
 *
 *   capture.v1 (audio frames: CHANNEL index + glow NAME bound at the source)
 *        ──►  transcript.v1 (named segments + live drafts)
 *
 * The combination of main's overlap engine + glow naming. Google Meet delivers
 * each active speaker on a SEPARATE channel, so audio is routed by CHANNEL: two
 * speakers talking at once land on separate per-channel streams and are
 * transcribed INDEPENDENTLY — no muddling, onsets intact. The glow names each
 * channel-TURN, bound at the turn's ONSET (a single tile lit, before any overlap)
 * and HELD through the overlap (where per-frame glow would be ambiguous → UNKNOWN).
 *
 * Each (channel, turn) is its OWN SpeakerStreamManager stream with a name FIXED at
 * onset (`ch-<n>:<turn>`). A turn ends on a silence gap OR a confident glow-name
 * CHANGE (overlap rotates a channel mid-stream with no gap), opening a fresh turn —
 * so a stream's name never relabels mid-flight — no async flush/relabel race.
 *
 * CONTRACT BOUNDARY: identity is CARRIED (the glow bound it at capture), never
 * derived. No diarizer, no post-hoc window-match.
 */
import { SpeakerStreamManager, type SpeakerStreamManagerConfig } from './speaker-streams.js';
import type { TranscriptionResult } from '@vexa/transcribe-whisper';
import type { TranscriptSegment, TranscriptSink } from './contracts/transcript-v1.js';

export interface GmeetPipelineOptions {
  /** One Whisper round-trip (stt.v1). language is baked into the closure by the host. */
  transcribe: (pcm: Float32Array, prompt?: string) => Promise<TranscriptionResult>;
  /** Where transcript.v1 segments + drafts land (consumer = collector/rendering). */
  sink: TranscriptSink;
  /** Label for a turn whose onset had no single confident glow. Default 'Speaker'. */
  unknownLabel?: string;
  /** SpeakerStreamManager tuning (turn gating / confirmation). */
  config?: SpeakerStreamManagerConfig;
  /** Silence gap (ms) on a channel that ends its turn (→ re-bind on the next onset). Default 1000. */
  onsetGapMs?: number;
  /** Maximum STT requests this bot may execute concurrently. Default 1: the production CPU
   *  worker loses throughput when one bot submits parallel inference jobs. */
  maxConcurrentTranscriptions?: number;
  /** Maximum ordinary live-draft STT requests retained by one bot (active + queued). Default 3.
   *  This budget may defer a replaceable live draft, but never a closed/final turn. */
  maxPendingTranscriptions?: number;
  /** Cooldown after a caller timeout before another request starts. Default 30s. The server can
   *  keep computing after fetch aborts, so immediate slot reuse would overlap orphaned inference. */
  timeoutRecoveryDelayMs?: number;
  /** Surface a transcribe FAILURE (P18: fail loud + attributable). The pipeline still
   *  degrades gracefully (empty turn) so it doesn't wedge, but it reports the fault here
   *  so the host can make it observable (a /ws health frame, telemetry, lifecycle) instead
   *  of a silent "no transcript". Receives the thrown value (e.g. a TranscriptionError). */
  onError?: (fault: unknown) => void;
}

export interface GmeetPipeline {
  /** One capture.v1 frame: CHANNEL index + glow NAME (undefined ⇒ no single glow now). */
  feedAudio(channel: number, glowName: string | undefined, pcm: Float32Array, tsMs: number): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
  resourceCounts(): { retainedPcmBytes: number };
}

export function createGmeetPipeline(opts: GmeetPipelineOptions): GmeetPipeline {
  const UNKNOWN = opts.unknownLabel ?? 'Speaker';
  const ONSET_GAP = opts.onsetGapMs ?? 1000;
  const requestedConcurrency = Math.floor(opts.maxConcurrentTranscriptions ?? 1);
  const MAX_CONCURRENT_TRANSCRIPTIONS = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? requestedConcurrency
    : 1;
  const requestedPending = Math.floor(opts.maxPendingTranscriptions ?? 3);
  const MAX_PENDING_TRANSCRIPTIONS = Math.max(
    MAX_CONCURRENT_TRANSCRIPTIONS,
    Number.isFinite(requestedPending) && requestedPending > 0 ? requestedPending : 3,
  );
  const requestedRecoveryDelayMs = Math.floor(opts.timeoutRecoveryDelayMs ?? 30_000);
  const TIMEOUT_RECOVERY_DELAY_MS = Number.isFinite(requestedRecoveryDelayMs) && requestedRecoveryDelayMs >= 0
    ? requestedRecoveryDelayMs
    : 30_000;
  const mgr = new SpeakerStreamManager(opts.config);
  const inflight = new Set<Promise<void>>();
  const closing = new Set<Promise<void>>();
  const closedTurns = new Set<string>();
  const pendingBySpeaker = new Map<string, number>();
  const terminalInFlightSpeakers = new Set<string>();
  const transcriptionWaiters: Array<() => void> = [];
  let activeTranscriptions = 0;
  let transcriptionBlockedUntilMs = 0;
  let disposing = false;
  let requestDispose: () => void = () => {};
  const disposeRequested = new Promise<void>((resolve) => { requestDispose = resolve; });
  let disposePromise: Promise<void> | undefined;
  // Per channel: the CURRENT turn's stream key, bound name, last-audio time, turn counter.
  const chan = new Map<number, { key: string; name: string; lastMs: number; turn: number }>();

  // Emit the SEALED transcript.v1 shape (snake_case, segment_id + completed, source
  // in the contract's enum) — the pipeline IS the transcript.v1 producer, so its
  // output conforms to meetings/contracts/transcript.v1 (pinned by the replay golden).
  const segOf = (speakerName: string, key: string, text: string, startMs: number, endMs: number, completed: boolean, lang?: string): TranscriptSegment => {
    const named = speakerName !== UNKNOWN;
    return {
      segment_id: `${key}:${Math.round(startMs)}`,
      speaker: speakerName, speaker_key: key, text,
      start: startMs / 1000, end: endMs / 1000, completed, words: [],
      language: lang ?? null,
      source: named ? 'glow-bound' : 'provisional-cluster-id',
      confidence: named ? 1 : 0,
    };
  };

  // The window's language off the stt.v1 result: the per-call detection in auto mode, or the
  // invocation-forced code (baked into the transcribe closure, echoed back by the service).
  // 'unknown' is the client's no-detection sentinel, not an ISO code — NULL stays honest.
  const langOf = (l: string | undefined): string | undefined =>
    l && l !== 'unknown' ? l : undefined;

  const pauseAfterUnknownTimeout = (fault: unknown): void => {
    if ((fault as { kind?: string } | null)?.kind !== 'timeout') return;
    transcriptionBlockedUntilMs = Math.max(
      transcriptionBlockedUntilMs,
      Date.now() + TIMEOUT_RECOVERY_DELAY_MS,
    );
  };

  const withTranscriptionSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      if (activeTranscriptions < MAX_CONCURRENT_TRANSCRIPTIONS) {
        activeTranscriptions++;
        resolve();
      } else {
        transcriptionWaiters.push(resolve);
      }
    });
    try {
      // Another concurrent request can time out while this waiter sleeps and extend the unknown-
      // server-work horizon. Recompute after every wake; a single snapshot can wake into the newer
      // orphan and overlap it.
      while (transcriptionBlockedUntilMs > Date.now()) {
        if (disposing) {
          throw Object.assign(
            new Error('meeting teardown began during STT timeout cooldown; refusing delayed request'),
            { source: 'stt', kind: 'overloaded', retryable: false },
          );
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, transcriptionBlockedUntilMs - Date.now());
          }),
          disposeRequested,
        ]);
        if (timer) clearTimeout(timer);
      }
      if (disposing && transcriptionBlockedUntilMs > 0) {
        throw Object.assign(
          new Error('meeting teardown began after an STT timeout; refusing recovery request'),
          { source: 'stt', kind: 'overloaded', retryable: false },
        );
      }
      return await work();
    } catch (fault) {
      // Trip BEFORE handing the slot to the next waiter. The server may keep computing after the
      // HTTP caller times out; releasing first creates a race where one more request starts.
      pauseAfterUnknownTimeout(fault);
      throw fault;
    } finally {
      const next = transcriptionWaiters.shift();
      if (next) next(); // hand this reserved slot directly to the next queued request
      else activeTranscriptions--;
    }
  };

  const releaseClosedTurn = (speakerId: string): void => {
    if (!closedTurns.has(speakerId) || (pendingBySpeaker.get(speakerId) ?? 0) > 0) return;
    mgr.removeSpeaker(speakerId);
    closedTurns.delete(speakerId);
  };

  mgr.onSegmentReady = (speakerId, _name, audio, requestId, terminal = false) => {
    // A deferred-final request is created synchronously while its superseded predecessor is still
    // in `inflight` (the predecessor's finally runs immediately after this callback returns). Let
    // that same-speaker replacement inherit the predecessor's budget slot; otherwise a cap of one
    // would discard audio appended after the first request snapshot.
    const replacingSameSpeaker = (pendingBySpeaker.get(speakerId) ?? 0) > 0;
    if (terminal && terminalInFlightSpeakers.has(speakerId)) {
      const fault = Object.assign(
        new Error(`terminal STT replacement already active for ${speakerId}`),
        { kind: 'overloaded', retryable: false },
      );
      try { opts.onError?.(fault); } catch { /* fault reporting must not wedge the speaker buffer */ }
      mgr.handleTranscriptionResult(speakerId, '', undefined, undefined, undefined, requestId);
      return;
    }
    if (!terminal && inflight.size >= MAX_PENDING_TRANSCRIPTIONS && !replacingSameSpeaker) {
      const fault = Object.assign(
        new Error(`bot STT backlog reached ${MAX_PENDING_TRANSCRIPTIONS} requests; refusing additional PCM retention`),
        { kind: 'overloaded', retryable: false },
      );
      try { opts.onError?.(fault); } catch { /* fault reporting must not wedge the speaker buffer */ }
      mgr.handleTranscriptionResult(speakerId, '', undefined, undefined, undefined, requestId);
      releaseClosedTurn(speakerId);
      return;
    }
    if (terminal) terminalInFlightSpeakers.add(speakerId);
    pendingBySpeaker.set(speakerId, (pendingBySpeaker.get(speakerId) ?? 0) + 1);
    let p: Promise<void>;
    p = (async () => {
      try {
        // A teardown-only terminal replacement intentionally overlaps its superseded draft. An
        // ordinary closed/final turn still uses the bounded FIFO: final audio is lossless, but it
        // must not recreate the parallel CPU-inference storm that caused production timeouts.
        const invoke = () => opts.transcribe(audio, mgr.getLastConfirmedText(speakerId) || undefined);
        const r = terminal && replacingSameSpeaker
          ? await invoke()
          : await withTranscriptionSlot(invoke);
        const segs = r?.segments;
        mgr.handleTranscriptionResult(speakerId, (r?.text || '').trim(), segs?.[segs.length - 1]?.end,
          segs, langOf(r?.language), requestId);
      } catch (e) {
        // A client timeout has an unknown server-side outcome: production evidence shows the CPU
        // service can keep transcribing after fetch aborts. The per-bot cooldown prevents the next
        // queued window from immediately overlapping that orphan and recreating the storm. Other
        // failures had an observed response (or their own bounded retry policy) and release normally.
        try { opts.onError?.(e); } catch { /* the original STT fault still must release the turn */ }
        mgr.handleTranscriptionResult(speakerId, '', undefined, undefined, undefined, requestId);
      }
    })().finally(() => {
      inflight.delete(p);
      if (terminal) terminalInFlightSpeakers.delete(speakerId);
      const remaining = (pendingBySpeaker.get(speakerId) ?? 1) - 1;
      if (remaining > 0) pendingBySpeaker.set(speakerId, remaining);
      else pendingBySpeaker.delete(speakerId);
      releaseClosedTurn(speakerId);
    });
    inflight.add(p);
  };

  mgr.onSegmentConfirmed = (speakerId, speakerName, text, startMs, endMs, _segmentId, lang) => {
    if (!text.trim()) return;
    opts.sink.segment(segOf(speakerName, speakerId, text, startMs, endMs, true, lang));
  };
  mgr.onSegmentPending = (speakerId, speakerName, text, startMs, lang) => {
    opts.sink.draft?.({ ...segOf(speakerName, speakerId, text, startMs, startMs, false, lang), confidence: 0 });
  };

  const settle = async () => {
    while (closing.size || inflight.size) await Promise.all([...closing, ...inflight]);
  };
  // Close a finished turn: retain its stream until every queued/in-flight request (including a
  // deferred final resubmit) has settled. STT's own request horizon is 30s, so a fixed 12s cleanup
  // timer was a guaranteed data-loss race under ordinary CPU inference latency.
  const closeTurn = (key: string, supersedeIncompleteRequest = false): void => {
    if (closedTurns.has(key) && !supersedeIncompleteRequest) return;
    closedTurns.add(key);
    let p: Promise<void>;
    p = mgr.flushSpeaker(key, true, undefined, supersedeIncompleteRequest)
      .catch((e) => {
        try { opts.onError?.(e); } catch { /* fault reporting must not reject pipeline disposal */ }
      })
      .finally(() => {
        closing.delete(p);
        releaseClosedTurn(key);
      });
    closing.add(p);
  };

  return {
    feedAudio: (channel, glowName, pcm, tsMs) => {
      let st = chan.get(channel);
      // A channel-turn ends on EITHER a silence gap OR a confident glow-name CHANGE.
      // The glow-change case is the one overlap breaks: a channel rotates to a new
      // speaker mid-stream with NO silence gap, so the gap alone would hold the stale
      // name (the Галина→Зоя mislabel). A different single glow IS the rotation signal.
      const gapOnset = !!st && tsMs - st.lastMs > ONSET_GAP;
      const glowRotation = !!st && !!glowName && st.name !== UNKNOWN && glowName !== st.name;
      if (!st || gapOnset || glowRotation) {
        // TURN ONSET / rotation: close the previous turn and open a fresh stream named
        // from the glow lit RIGHT NOW (fixed for the turn — held through overlap below).
        if (st) closeTurn(st.key);
        const turn = (st ? st.turn : 0) + 1;
        const key = `ch-${channel}:${turn}`;
        st = { key, name: glowName || UNKNOWN, lastMs: tsMs, turn };
        chan.set(channel, st);
        mgr.addSpeaker(key, st.name);
      } else if (st.name === UNKNOWN && glowName) {
        // Onset was during overlap (no single glow) → opened UNKNOWN; a confident single
        // glow has now appeared early in the turn → adopt it (upgrade unknown→name only).
        st.name = glowName;
        mgr.updateSpeakerName(st.key, glowName);
      }
      st.lastMs = tsMs;
      mgr.feedAudio(st.key, pcm, tsMs);
    },
    flush: async () => { for (const st of chan.values()) await mgr.flushSpeaker(st.key, true); await settle(); },
    dispose: () => {
      if (disposePromise) return disposePromise;
      disposing = true;
      requestDispose();
      disposePromise = (async () => {
        // Include turns already closed by a channel change: one may still own an incomplete live
        // snapshot and must receive the same immediate terminal replacement at meeting teardown.
        for (const key of mgr.getActiveSpeakers()) closeTurn(key, true);
        await settle();
        mgr.removeAll();
        chan.clear();
        await opts.sink.finalize();
      })();
      return disposePromise;
    },
    resourceCounts: () => ({ retainedPcmBytes: mgr.resourceCounts().retainedPcmBytes }),
  };
}
