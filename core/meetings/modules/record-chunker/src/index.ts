/**
 * @vexa/record-chunker — the shared browser MediaRecorder driver.
 *
 * MODIFIED BY TINYCLOUD (fork branch `tinycloud`, github.com/TinyCloudLabs/vexa):
 * createRecordingTap's element combine is now DYNAMIC (DynamicElementMixer) — it
 * starts with whatever audio is present (or none) and keeps attaching media
 * elements that appear later, mirroring the live mixed-lane rescan.
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
 * No fallbacks: if `onChunk` throws or returns false we splice the chunk anyway
 * and log (the server-side reconciler re-fetches via the chunk_seq contract);
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
}

const BUFFER_CAP = 10;

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
  private pending: Blob[] = [];
  private resolveFinalChunk: (() => void) | null = null;
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
      return;
    }

    this.recorder = recorder;
    this.mimeType = recorder.mimeType || chosen || "audio/webm";

    // t=0 of the master — listeners align segment timestamps to audio origin.
    recorder.onstart = () => { try { this.opts.onStarted?.(); } catch { /* */ } };

    recorder.ondataavailable = async (event: BlobEvent) => {
      if (!(event.data && event.data.size > 0)) {
        blog("[record-chunker] dataavailable fired with empty data (skipping)");
        return;
      }

      // Defensive buffer + cap — successful callbacks splice; the cap should
      // never trip in normal operation (the reconciler re-fetches if it does).
      this.pending.push(event.data);
      if (this.pending.length > BUFFER_CAP) {
        const dropped = this.pending.shift();
        blog(`[record-chunker] WARN buffer exceeded cap ${BUFFER_CAP}, dropped oldest (${dropped?.size ?? 0} bytes); reconciler will re-fetch`);
      }

      const seq = this.chunkSeq;
      this.chunkSeq = seq + 1;

      try {
        const arrBuffer = await event.data.arrayBuffer();
        let bytes = new Uint8Array(arrBuffer);

        // Retain the EBML init segment from the FIRST self-describing blob. webm/Matroska always
        // starts with `1a 45 df a3`; MediaRecorder puts EBML + Segment + Tracks in chunk 0.
        if (!this.initSegment && isWebmHeader(bytes)) this.initSegment = bytes;

        // If the init segment has NOT yet been delivered (chunk 0's own send failed over the
        // bridge) and THIS chunk is cluster-only, PREPEND the retained header so the master is
        // never assembled headerless. The byte-concat codec keeps this valid: a chunk that is
        // [EBML init][cluster] is exactly what a self-describing chunk 0 looks like.
        if (this.initSegment && !this.initSegmentDelivered && !isWebmHeader(bytes)) {
          const merged = new Uint8Array(this.initSegment.length + bytes.length);
          merged.set(this.initSegment, 0);
          merged.set(bytes, this.initSegment.length);
          bytes = merged;
          blog(`[record-chunker] chunk ${seq} re-attached EBML init segment (${this.initSegment.length}B) — chunk 0 delivery was lost`);
        }

        const carriesHeader = isWebmHeader(bytes);
        // OPTIMISTICALLY mark the init segment delivered the moment a header-bearing chunk is
        // DISPATCHED (not after its await resolves), so a chunk emitted while chunk 0 is still
        // in flight does not redundantly re-attach the header. On a confirmed failure below we
        // clear the flag again so the NEXT surviving chunk carries the retained init segment.
        if (carriesHeader) this.initSegmentDelivered = true;

        let binary = "";
        const encodeChunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += encodeChunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + encodeChunkSize));
        }
        const base64 = btoa(binary);
        blog(`[record-chunker] chunk ${seq} (${bytes.length} bytes)`);
        try {
          const ok = await this.opts.onChunk({ base64, chunkSeq: seq, isFinal: false, mimeType: this.mimeType });
          // A header-bearing chunk that the sink REJECTED is not delivered — clear the flag so the
          // retained init segment is re-attached to the next surviving (cluster-only) chunk.
          if (!ok && carriesHeader) this.initSegmentDelivered = false;
          if (!ok) blog(`[record-chunker] chunk ${seq} callback returned false — sink rejected; reconciler will re-fetch`);
        } catch (cbErr: any) {
          if (carriesHeader) this.initSegmentDelivered = false;
          blog(`[record-chunker] chunk ${seq} callback threw: ${cbErr?.message || cbErr}; reconciler will re-fetch`);
        } finally {
          const idx = this.pending.indexOf(event.data);
          if (idx >= 0) this.pending.splice(idx, 1);
        }
      } catch (err: any) {
        const idx = this.pending.indexOf(event.data);
        if (idx >= 0) this.pending.splice(idx, 1);
        blog(`[record-chunker] chunk ${seq} encode FAILED: ${err?.message || err}; spliced`);
      }
    };

    recorder.onstop = async () => {
      // Final chunk (empty body OK — server treats isFinal=true as the COMPLETED signal).
      try {
        const finalSeq = this.chunkSeq;
        this.chunkSeq = finalSeq + 1;
        await this.opts.onChunk({ base64: "", chunkSeq: finalSeq, isFinal: true, mimeType: this.mimeType });
        blog(`[record-chunker] final chunk emitted (seq=${finalSeq})`);
      } catch (err: any) {
        blog(`[record-chunker] final chunk callback failed: ${err?.message || err}`);
      } finally {
        if (this.resolveFinalChunk) { this.resolveFinalChunk(); this.resolveFinalChunk = null; }
      }
    };

    recorder.start(this.opts.timesliceMs ?? 15000);
    blog(`[record-chunker] MediaRecorder started (${this.mimeType}, timeslice=${this.opts.timesliceMs ?? 15000}ms)`);
  }

  async stop(): Promise<void> {
    if (!this.recorder) { blog("[record-chunker] stop() before start() — ignoring"); return; }
    if (this.recorder.state === "inactive") { blog("[record-chunker] recorder already inactive"); return; }

    const finalChunkPromise = new Promise<void>((resolve) => {
      this.resolveFinalChunk = resolve;
      setTimeout(() => {
        if (this.resolveFinalChunk) {
          blog("[record-chunker] final chunk timeout — resolving");
          this.resolveFinalChunk(); this.resolveFinalChunk = null;
        }
      }, 10000);
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
/** True when the stream has at least one LIVE audio track. Liveness (not mere track
 *  presence) is required — otherwise an ended stream would detach and immediately
 *  re-attach on every rescan. */
function hasLiveAudio(s: any): boolean {
  try {
    return s instanceof MediaStream
      && s.getAudioTracks().some((t: any) => t.readyState === undefined || t.readyState === "live");
  } catch { return false; }
}

function probeElementStream(el: any): MediaStream | null {
  try {
    if (hasLiveAudio(el.srcObject)) return el.srcObject;
    if (typeof el.captureStream === "function") {
      const s = el.captureStream();
      if (hasLiveAudio(s)) return s;
    }
    if (typeof el.mozCaptureStream === "function") {
      const s = el.mozCaptureStream();
      if (hasLiveAudio(s)) return s;
    }
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
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  /** element → the stream/source we attached for it (dedupe + detach bookkeeping). */
  private attached = new Map<any, { stream: MediaStream; source: MediaStreamAudioSourceNode }>();
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

  /** One pass: detach dead sources, attach new audio-bearing elements. Never throws. */
  scan(): void {
    try {
      // Autoplay policy can leave a gesture-less AudioContext suspended → silent mix.
      if ((this.ctx as any).state === "suspended") (this.ctx as any).resume?.();

      // Detach: all tracks ended, element left the DOM, or srcObject was swapped
      // for a NEW stream (the swap re-attaches below under the new stream).
      for (const [el, a] of Array.from(this.attached.entries())) {
        const tracksLive = a.stream.getAudioTracks().some((t: any) => t.readyState === "live");
        const inDom = (document as any).contains ? (document as any).contains(el) : true;
        const swapped = el.srcObject instanceof MediaStream && el.srcObject !== a.stream
          && hasLiveAudio(el.srcObject);
        if (tracksLive && inDom && !swapped) continue;
        try { a.source.disconnect(); } catch { /* already gone */ }
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
        const s = probeElementStream(el);
        if (!s) continue;
        try {
          const source = this.ctx.createMediaStreamSource(s);
          source.connect(this.dest);
          this.attached.set(el, { stream: s, source });
          blog(`[record-chunker] attached media element (${this.attached.size} attached)`);
        } catch (e: any) {
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
    for (const [, a] of this.attached) { try { a.source.disconnect(); } catch { /* */ } }
    this.attached.clear();
    try { (this.ctx as any).close?.(); } catch { /* */ }
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
    },
    async stop(): Promise<void> {
      await chunker?.stop();   // flush the final chunk BEFORE tearing the mix down
      chunker = null;
      mixer?.stop();
      mixer = null;
    },
  };
}
