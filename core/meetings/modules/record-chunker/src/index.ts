/**
 * @vexa/record-chunker — the shared browser MediaRecorder driver.
 *
 * `createRecordingTap` owns a dynamic page-element mix: it begins with whatever
 * audio is present (including none) and attaches media that arrives later.
 *
 * Runs in browser context. Wraps a MediaRecorder over a combined audio
 * MediaStream, encodes each timeslice to base64, and hands it to an injected
 * `onChunk` callback (the recording.v1 chunk shape). On stop it emits one final
 * chunk with `isFinal: true`. NO master assembly here — the master is built
 * server-side (meeting-api `recording_finalizer.py`) from the chunk_seq sequence.
 *
 * Both lane recording taps use this once: `@vexa/gmeet-capture` (gmeet) and
 * `@vexa/mixed-capture-core` (mixed/teams). The combine-the-audio step differs
 * per lane (gmeet builds a combined stream from its media elements; mixed
 * already has one mixed stream) — that lives in each lane; the MediaRecorder
 * loop is identical and lives here.
 *
 * A rejected bridge acknowledgement is terminal: the recorder stops and `stop()` rejects rather
 * than sending a final marker that would claim completion after an admitted chunk was lost.
 * if no supported mimeType exists we log and refuse to start.
 */

/** One recording chunk, ready for upload. Mirrors the recording.v1 wire shape. */
export interface RecordingChunk {
  base64: string;
  chunkSeq: number;
  isFinal: boolean;
  mimeType: string;
}

/** A lane recording tap — what `createGmeetRecordingTap` / `createMixedRecordingTap` return. */
export interface RecordingTap {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Owned browser-side state, exposed for lifecycle regressions and diagnostics. */
  releaseCounts?(): { mixers: number; contexts: number; sources: number; listeners: number; intervals: number; retainedReferences: number };
}

/** Options a host passes to a lane recording tap. */
export interface RecordingTapOptions {
  /** MediaRecorder timeslice in ms (default 15000 — matches the WAV chunk size). */
  timesliceMs?: number;
  /** Receives each chunk. Return false / throw → the chunk is spliced anyway (reconciler re-fetches). */
  onChunk: (chunk: RecordingChunk) => Promise<boolean> | boolean;
  /** Fired ONCE on MediaRecorder.onstart — t=0 of the master (segment↔audio alignment). */
  onStarted?: () => void;
}

export interface MediaRecorderChunkerOptions extends RecordingTapOptions {
  /** Combined audio stream to record (lane-built). */
  stream: MediaStream;
  /** Maximum Blob bytes owned between MediaRecorder and the Node bridge. */
  maxPendingBytes?: number;
  /** A stopped recorder that never produces its terminal event is a failed recording, not success. */
  stopTimeoutMs?: number;
}

const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;

/** The 4-byte EBML magic every valid webm/Matroska stream starts with (`1a 45 df a3`). */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** True when `bytes` begins with the EBML header (i.e. it is a self-describing webm init segment,
 *  not a cluster-only continuation chunk). */
function isWebmHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && EBML_MAGIC.every((b, i) => bytes[i] === b);
}

const blog = (msg: string) => { try { (window as any).logBot?.(msg); } catch { /* */ } };

/**
 * Drives a MediaRecorder over `stream`, emitting base64 chunks via `onChunk`.
 * Lifecycle: start() → chunks per timeslice → stop() resolves AFTER the final
 * chunk callback completes.
 */
export class MediaRecorderChunker implements RecordingTap {
  private opts: MediaRecorderChunkerOptions;
  private recorder: MediaRecorder | null = null;
  private chunkSeq = 0;
  private pending: Array<{ blob: Blob; seq: number }> = [];
  private pendingBytes = 0;
  private processing = false;
  private failure: Error | null = null;
  private resolveFinalChunk: (() => void) | null = null;
  private rejectFinalChunk: ((error: Error) => void) | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private mimeType = "audio/webm";
  /**
   * The webm EBML init segment retained from the FIRST self-describing blob (chunk 0:
   * `1a 45 df a3` EBML + Segment + Tracks + first Cluster). Held so it can be re-attached to a
   * later surviving chunk when chunk 0's own delivery fails over the page→Node base64 bridge;
   * without it the assembler would build a headerless (mid-Matroska `43 b6 75 …`) master from the
   * cluster-only survivors, which no player accepts. */
  private initSegment: Uint8Array | null = null;
  /** False until a chunk carrying the EBML header has been ACK'd by `onChunk` (returned truthy). */
  private initSegmentDelivered = false;

  constructor(opts: MediaRecorderChunkerOptions) {
    this.opts = opts;
  }

  /** The underlying MediaRecorder (null until start()). */
  getMediaRecorder(): MediaRecorder | null {
    return this.recorder;
  }

  /** Bytes and chunks retained by this browser-side admission boundary. */
  resourceCounts(): { retainedBytes: number; queuedChunks: number; processing: boolean; failed: boolean } {
    return {
      retainedBytes: this.pendingBytes,
      queuedChunks: this.pending.length,
      processing: this.processing,
      failed: !!this.failure,
    };
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    // Delivery already in progress owns its Blob until its promise settles, but no queued Blob
    // can ever be delivered after a terminal failure. Drop those references immediately.
    for (const item of this.pending) this.pendingBytes -= item.blob.size;
    this.pending = [];
    blog(`[record-chunker] terminal failure: ${this.failure.message}`);
    const recorder = this.recorder;
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* terminal state is reported by stop() */ }
  }

  private maxPendingBytes(): number {
    return this.opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  private pump(): void {
    if (this.processing || this.failure) return;
    const next = this.pending.shift();
    if (!next) return;
    this.processing = true;
    void this.deliver(next).finally(() => {
      this.pendingBytes -= next.blob.size;
      this.processing = false;
      this.pump();
    });
  }

  private async deliver(item: { blob: Blob; seq: number }): Promise<void> {
    try {
      const arrBuffer = await item.blob.arrayBuffer();
      let bytes = new Uint8Array(arrBuffer);
      if (!this.initSegment && isWebmHeader(bytes)) this.initSegment = bytes;
      if (this.initSegment && !this.initSegmentDelivered && !isWebmHeader(bytes)) {
        const merged = new Uint8Array(this.initSegment.length + bytes.length);
        merged.set(this.initSegment, 0);
        merged.set(bytes, this.initSegment.length);
        bytes = merged;
        blog(`[record-chunker] chunk ${item.seq} re-attached EBML init segment (${this.initSegment.length}B)`);
      }
      const carriesHeader = isWebmHeader(bytes);
      let binary = '';
      const encodeChunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += encodeChunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + encodeChunkSize));
      const ok = await this.opts.onChunk({ base64: btoa(binary), chunkSeq: item.seq, isFinal: false, mimeType: this.mimeType });
      if (carriesHeader) this.initSegmentDelivered = !!ok;
      // A false bridge acknowledgement means the durable sink did not own this admitted chunk.
      // Continuing to a final marker would falsely claim a complete recording.
      if (!ok) throw new Error(`recording chunk ${item.seq} was rejected by the bridge`);
      blog(`[record-chunker] chunk ${item.seq} (${bytes.length} bytes)`);
    } catch (error) {
      this.fail(error);
    }
  }

  async start(): Promise<void> {
    if (this.recorder) {
      blog("[record-chunker] start() called twice — ignoring");
      return;
    }

    // Pick the best supported mimeType. No fallback beyond the candidate list.
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    let chosen = "";
    for (const mime of candidates) {
      try {
        if ((window as any).MediaRecorder?.isTypeSupported?.(mime)) { chosen = mime; break; }
      } catch { /* */ }
    }

    let recorder: MediaRecorder;
    try {
      recorder = chosen
        ? new MediaRecorder(this.opts.stream, { mimeType: chosen })
        : new MediaRecorder(this.opts.stream);
    } catch (err: any) {
      blog(`[record-chunker] Failed to construct MediaRecorder: ${err?.message || err}`);
      throw err;
    }

    this.recorder = recorder;
    this.mimeType = recorder.mimeType || chosen || "audio/webm";

    // t=0 of the master — listeners align segment timestamps to audio origin.
    recorder.onstart = () => { try { this.opts.onStarted?.(); } catch { /* */ } };

    const maxPendingBytes = this.maxPendingBytes();
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) throw new Error('record-chunker maxPendingBytes must be a positive integer');

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!(event.data && event.data.size > 0)) {
        blog("[record-chunker] dataavailable fired with empty data (skipping)");
        return;
      }

      if (this.failure) return;
      // The browser cannot await an event listener. Admit its Blob synchronously while the owned
      // delivery queue has room. MediaRecorder stays continuous: pausing after every upload loses
      // meeting audio under a slow acknowledgement. Once the genuinely byte-bounded queue is full,
      // fail and stop instead of silently omitting the interval that arrived while paused.
      if (event.data.size > maxPendingBytes || this.pendingBytes + event.data.size > maxPendingBytes) {
        this.fail(new Error(`recording producer overflow: ${event.data.size}B event exceeds ${maxPendingBytes}B pending budget`));
        return;
      }
      const seq = this.chunkSeq++;
      this.pending.push({ blob: event.data, seq });
      this.pendingBytes += event.data.size;
      this.pump();
    };

    recorder.onstop = async () => {
      while ((this.processing || this.pending.length) && !this.failure) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.failure) {
        if (this.finalTimer !== null) { clearTimeout(this.finalTimer); this.finalTimer = null; }
        this.rejectFinalChunk?.(this.failure); this.resolveFinalChunk = null; this.rejectFinalChunk = null;
        return;
      }
      // Final chunk (empty body OK — server treats isFinal=true as the COMPLETED signal).
      try {
        const finalSeq = this.chunkSeq;
        this.chunkSeq = finalSeq + 1;
        const acknowledged = await this.opts.onChunk({ base64: "", chunkSeq: finalSeq, isFinal: true, mimeType: this.mimeType });
        if (!acknowledged) throw new Error(`recording final chunk ${finalSeq} was rejected by the bridge`);
        blog(`[record-chunker] final chunk emitted (seq=${finalSeq})`);
      } catch (err: any) {
        this.fail(err);
      } finally {
        if (this.finalTimer !== null) { clearTimeout(this.finalTimer); this.finalTimer = null; }
        if (this.failure) this.rejectFinalChunk?.(this.failure); else this.resolveFinalChunk?.();
        this.resolveFinalChunk = null; this.rejectFinalChunk = null;
      }
    };

    recorder.start(this.opts.timesliceMs ?? 15000);
    blog(`[record-chunker] MediaRecorder started (${this.mimeType}, timeslice=${this.opts.timesliceMs ?? 15000}ms)`);
  }

  async stop(): Promise<void> {
    if (!this.recorder) { blog("[record-chunker] stop() before start() — ignoring"); return; }
    if (this.recorder.state === "inactive") {
      if (this.failure) throw this.failure;
      blog("[record-chunker] recorder already inactive");
      return;
    }

    const finalChunkPromise = new Promise<void>((resolve, reject) => {
      this.resolveFinalChunk = resolve;
      this.rejectFinalChunk = reject;
      this.finalTimer = setTimeout(() => {
        this.finalTimer = null;
        if (this.rejectFinalChunk) {
          const error = new Error('MediaRecorder stop timed out before the recording drained');
          this.fail(error);
          this.rejectFinalChunk(error); this.resolveFinalChunk = null; this.rejectFinalChunk = null;
        }
      }, this.opts.stopTimeoutMs ?? 10000);
    });

    try { this.recorder.stop(); }
    catch (err: any) { blog(`[record-chunker] recorder.stop() threw: ${err?.message || err}`); }

    await finalChunkPromise;
  }
}

// ───────────────────────────────────────────────────────────────────────
// createRecordingTap — the full browser recording tap (generic, all platforms)
// ───────────────────────────────────────────────────────────────────────

/**
 * How often the dynamic mix rescans the page for media-element changes (ms).
 * Mirrors the live mixed-lane rescan (capture-bridge `__vexaMixRescan`, 2000ms) —
 * the mechanism that already makes the LIVE path hear late-arriving tracks.
 */
const RESCAN_MS = 2000;

/**
 * Probe one media element for an audio-bearing MediaStream. srcObject preferred;
 * captureStream()/mozCaptureStream() as fallbacks (tiles can be paused or expose
 * audio only via capture). Returns null when the element has no usable audio yet —
 * the rescan will probe it again later.
 */
/** ONE liveness rule for attach and detach. A track whose host does not expose
 *  `readyState` counts as live, so the same track cannot read live to the attach
 *  pass and ended to the detach pass — that disagreement would attach and detach
 *  the same element on every rescan. */
function isLiveTrack(t: any): boolean {
  return t?.readyState === undefined || t.readyState === "live";
}

/** True when the stream has at least one LIVE audio track. Liveness (not mere track
 *  presence) is required — otherwise an ended stream would detach and immediately
 *  re-attach on every rescan. */
function hasLiveAudio(s: any): boolean {
  try {
    return s instanceof MediaStream && s.getAudioTracks().some(isLiveTrack);
  } catch { return false; }
}

interface ElementStream {
  stream: MediaStream;
  /** captureStream creates tracks we own; srcObject tracks belong to the meeting. */
  owned: boolean;
  /** captureStream may return a fresh stream while srcObject stays null, unlike a direct source. */
  fromSrcObject: boolean;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) { try { track.stop(); } catch { /* already gone */ } }
}

function probeElementStream(el: any): ElementStream | null {
  try {
    // Capturing a stream-backed video-only tile cannot discover extra audio. It
    // creates another live video track on every rescan, retaining browser media
    // resources even though this recorder never consumes video.
    if (el.srcObject instanceof MediaStream) {
      return hasLiveAudio(el.srcObject) ? { stream: el.srcObject, owned: false, fromSrcObject: true } : null;
    }
    const capture = el.captureStream ?? el.mozCaptureStream;
    if (typeof capture !== "function") return null;
    const stream: MediaStream = capture.call(el);
    if (!hasLiveAudio(stream)) { stopTracks(stream); return null; }
    // Only fallback tracks are ours to stop. Never stop the meeting's original
    // audio/video tracks; doing so would disrupt playback and live capture.
    for (const track of stream.getTracks()) {
      if (track.kind !== 'audio') { try { track.stop(); } catch { /* already gone */ } }
    }
    return { stream, owned: true, fromSrcObject: false };
  } catch { /* not probeable yet; the rescan retries */ }
  return null;
}

/**
 * DYNAMIC element mixer — the recording-tap twin of the live lane's `setupMix`
 * rescan loop. Mixes every audio-bearing media element into ONE destination
 * stream, and KEEPS attaching elements that appear (or whose srcObject changes)
 * after the tap started. This is the fix for the two batch-recording defects the
 * static combine had:
 *   1. a participant whose audio track arrives AFTER the tap starts (e.g. joins
 *      after the bot) was absent from the master although the live mixer heard
 *      him — the tap grabbed the elements once at start and never looked again;
 *   2. a room with NO audio-bearing element at tap start produced no recording
 *      at all (or latched onto a stale/silent element).
 * The destination node's stream always carries one audio track, so the
 * MediaRecorder can start over an EMPTY mix and pick up audio as it appears.
 * Detach (track ended / element removed / srcObject swapped) is handled on the
 * same rescan and must never crash the recording.
 */
export class DynamicElementMixer {
  private ctx: AudioContext | null;
  private dest: MediaStreamAudioDestinationNode | null;
  /** element → the stream/source we attached for it (dedupe + detach bookkeeping). */
  private attached = new Map<any, ElementStream & { source: MediaStreamAudioSourceNode }>();
  private timer: any = null;
  private rescanMs: number;
  /** The combined mix — hand this to the MediaRecorderChunker. */
  readonly stream: MediaStream;

  constructor(rescanMs = RESCAN_MS) {
    this.rescanMs = rescanMs;
    this.ctx = new AudioContext();
    (this.ctx as any).resume?.();
    this.dest = this.ctx.createMediaStreamDestination();
    this.stream = this.dest.stream;
  }

  /** How many elements are currently feeding the mix. */
  get attachedCount(): number { return this.attached.size; }

  resourceCounts(): { contexts: number; sources: number; listeners: number; intervals: number; retainedReferences: number } {
    return {
      contexts: this.ctx ? 1 : 0,
      sources: this.attached.size,
      listeners: this.attached.size,
      intervals: this.timer ? 1 : 0,
      retainedReferences: this.attached.size + (this.ctx ? 1 : 0) + (this.dest ? 1 : 0),
    };
  }

  /** One pass: detach dead sources, attach new audio-bearing elements. Never throws. */
  scan(): void {
    try {
      if (!this.ctx || !this.dest) return;
      // Autoplay policy can leave a gesture-less AudioContext suspended → silent mix.
      if ((this.ctx as any).state === "suspended") (this.ctx as any).resume?.();

      // Detach: all tracks ended, element left the DOM, or srcObject was swapped
      // for a NEW stream (the swap re-attaches below under the new stream).
      for (const [el, a] of Array.from(this.attached.entries())) {
        const tracksLive = a.stream.getAudioTracks().some(isLiveTrack);
        const inDom = (document as any).contains ? (document as any).contains(el) : true;
        const swapped = a.fromSrcObject && el.srcObject !== a.stream;
        if (tracksLive && inDom && !swapped) continue;
        try { a.source.disconnect(); } catch { /* already gone */ }
        if (a.owned) stopTracks(a.stream);
        this.attached.delete(el);
        const why = !tracksLive ? "tracks ended" : !inDom ? "removed from DOM" : "srcObject swapped";
        blog(`[record-chunker] detached media element (${why}); ${this.attached.size} attached`);
      }

      // Attach anything new. Dedupe by ELEMENT (not stream id): captureStream()
      // returns a fresh stream per call, so a stream-id dedupe would re-attach
      // capture-stream elements on every rescan.
      const all = Array.from(document.querySelectorAll("audio, video"));
      for (const el of all) {
        if (this.attached.has(el)) continue;
        const attachment = probeElementStream(el);
        if (!attachment) continue;
        try {
          const source = this.ctx.createMediaStreamSource(attachment.stream);
          source.connect(this.dest);
          this.attached.set(el, { ...attachment, source });
          blog(`[record-chunker] attached media element (${this.attached.size} attached)`);
        } catch (e: any) {
          if (attachment.owned) stopTracks(attachment.stream);
          blog(`[record-chunker] could not attach media element: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      blog(`[record-chunker] rescan failed (recording continues): ${e?.message || e}`);
    }
  }

  /** Initial scan + periodic rescan (the late-joiner mechanism). */
  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.rescanMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const [, a] of this.attached) {
      try { a.source.disconnect(); } catch { /* */ }
      if (a.owned) stopTracks(a.stream);
    }
    this.attached.clear();
    try { (this.ctx as any)?.close?.(); } catch { /* */ }
    this.dest = null;
    this.ctx = null;
  }
}

/** Options for createRecordingTap — combine all audio elements then optionally override. */
export interface CreateRecordingTapOptions extends RecordingTapOptions {
  /** Provide a ready stream to record (e.g. the mixed-lane tab stream); else all audio elements are combined. */
  stream?: MediaStream;
  /** Media-element rescan interval for the dynamic mix (default 2000ms — live-mixer parity). */
  rescanMs?: number;
}

/**
 * The browser recording tap, used by BOTH lanes (gmeet, teams) and both hosts
 * (bot, extension): find every audio element → combine → `MediaRecorderChunker`
 * → recording.v1 chunks via `onChunk`. Recording is platform-agnostic — it
 * records the whole meeting mix — so this is ONE generic tap, not per-lane.
 * (Zoom records via node PulseAudio in @vexa/recording, no browser tap.)
 *
 * Pass `opts.stream` to record a ready stream directly (skips the element
 * combine); otherwise it finds + combines the page's audio elements.
 */
export function createRecordingTap(opts: CreateRecordingTapOptions): RecordingTap {
  let chunker: MediaRecorderChunker | null = null;
  let mixer: DynamicElementMixer | null = null;
  return {
    async start(): Promise<void> {
      try {
        let stream = opts.stream;
        if (!stream) {
          // Dynamic mix: start recording IMMEDIATELY over the (possibly empty)
          // destination stream and let the rescan attach media elements as they
          // appear — late joiners land in the master, and an empty-at-join room
          // still yields a recording once someone with audio arrives.
          mixer = new DynamicElementMixer(opts.rescanMs ?? RESCAN_MS);
          mixer.start();
          stream = mixer.stream;
          blog(`[record-chunker] dynamic mix started (${mixer.attachedCount} elements at start; rescan every ${opts.rescanMs ?? RESCAN_MS}ms)`);
        }
        chunker = new MediaRecorderChunker({
          stream,
          timesliceMs: opts.timesliceMs ?? 15000,
          onChunk: opts.onChunk,
          onStarted: opts.onStarted,
        });
        await chunker.start();
      } catch (error) {
        // `start()` owns a mixer before MediaRecorder is known to be viable. A construction/start
        // rejection must release that partial graph immediately; callers may still call stop().
        chunker = null;
        mixer?.stop();
        mixer = null;
        throw error;
      }
    },
    async stop(): Promise<void> {
      let failure: unknown;
      try {
        await chunker?.stop();   // flush the final chunk BEFORE tearing the mix down
      } catch (error) {
        failure = error;
      } finally {
        // A failed final upload/MediaRecorder stop must not retain page mixer resources.  The
        // original failure is rethrown after every source, interval, AudioContext and reference
        // owned by this tap has been released.
        chunker = null;
        mixer?.stop();
        mixer = null;
      }
      if (failure) throw failure;
    },
    releaseCounts() {
      const counts = mixer?.resourceCounts();
      return {
        mixers: mixer ? 1 : 0,
        contexts: counts?.contexts ?? 0,
        sources: counts?.sources ?? 0,
        listeners: counts?.listeners ?? 0,
        intervals: counts?.intervals ?? 0,
        retainedReferences: counts?.retainedReferences ?? 0,
      };
    },
  };
}
