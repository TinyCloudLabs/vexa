/**
 * RecordingSink adapter (2b) — the recording.v1 PER-CHUNK durable upload path, behind the
 * orchestrator's RecordingSink port (`close(key)`).
 *
 * recording.v1 has TWO halves (both in @vexa/recording): ACQUIRE (the browser MediaRecorder tap →
 * timeslice chunks, capture-bridge.ts `startRecording`) and DELIVER (this file). #491/#412: the 0.12
 * bot ACCUMULATED every chunk in Node memory (createRecordingAssembler) and uploaded ONE master at
 * graceful close — so a SIGKILL/OOM mid-meeting lost the WHOLE recording (V2/#412), and a multi-hour
 * master rode one 30s-timeout POST that fails permanently on a slow link. This sink instead uploads
 * EACH timeslice the moment it is produced via RecordingService.uploadChunk (retry+backoff), so a
 * crash leaves every FINISHED part durable in object storage; the master is assembled SERVER-SIDE on
 * the first GET /recordings/{id}/master or …/raw (meeting-api finalize-on-read). No meeting-length
 * blob ever sits in Node memory or rides one long POST.
 *
 * Contract that must hold (or the recording 404s / splits / never completes):
 *   • session_uid == inv.connectionId — the eager-created MeetingSession the server resolves the
 *     upload against (bot_spawn). NOT nativeMeetingId / a master key (the old uploadMaster fallbacks
 *     would 404 SessionNotFound or fold into the wrong recording).
 *   • the empty is_final chunk is the COMPLETED signal — forward it (do NOT drop it).
 *   • close(key) is the final-signal FALLBACK: the live Stop race routinely drops the trailing
 *     is_final MediaRecorder chunk (the WS closes before it flushes), so on close we POST one empty
 *     is_final upload IF none was sent — the server then flips the recording to COMPLETED. Fires once.
 *   • uploads are serialized on an internal promise queue so parts land in seq order; a chunk that
 *     fails permanently is logged-and-skipped — the master assembles from the parts that DID arrive.
 *
 * L4-gated: the full page→Node→HTTP loss path is proven only by a live compose run. The SINK half
 * (per-chunk upload, correct seq/isFinal/session_uid, the close fallback) is offline-provable
 * (recording.test.ts) — the P22/#224-class regression pin the 0.12 in-memory bot lacked. The
 * assembler stays in @vexa/recording (the desktop composition root still uses it) — only the cloud
 * bot's wiring changes.
 */
import { RecordingService, type RecordingMasterFormat } from '@vexa/recording';
import type { Invocation } from './config.js';
import type { RecordingSink } from './ports.js';

/** The RecordingSink extended with the chunk ingress the capture bridge's MediaRecorder tap pumps
 *  into. The orchestrator only sees close(key); the bridge holds the BotRecordingSink to feed chunks
 *  as they arrive from the page-side recorder. */
export interface BotRecordingSink extends RecordingSink {
  /** One recording.v1 chunk for `key`: monotonic seq, the COMPLETED-signal flag, format, bytes. */
  chunk(key: string, seq: number, isFinal: boolean, format: RecordingMasterFormat, bytes: Uint8Array): Promise<void>;
  /** Application-owned delivery state. Values settle to zero after a successful or failed close. */
  resourceCounts(): { retainedBytes: number; queuedChunks: number; failed: boolean };
}

/** Deliver ONE recording.v1 chunk. The default uploads to inv.recordingUploadUrl via
 *  RecordingService.uploadChunk; tests inject a fake to assert per-chunk delivery without HTTP. */
export type ChunkUploader = (
  seq: number, isFinal: boolean, format: RecordingMasterFormat, bytes: Uint8Array,
) => void | Promise<void>;

export interface RecordingSinkOptions {
  inv: Invocation;
  /** Override the chunk uploader (tests inject this to assert per-chunk upload without a live
   *  receiver). Default = HTTP upload to inv.recordingUploadUrl via RecordingService.uploadChunk. */
  uploadChunk?: ChunkUploader;
  log?: (msg: string) => void;
  /** Maximum bytes admitted to Node-owned recording delivery. Default: 16 MiB. */
  maxRetainedBytes?: number;
}

/** The bot must never turn a slow uploader into an unbounded in-memory recording. */
export const DEFAULT_MAX_RECORDING_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_RECORDING_CHUNKS = 128;

/** The default chunk uploader: POST each chunk to meeting-api's internal upload endpoint via the
 *  shipped RecordingService.uploadChunk (multipart, retry+backoff, structured chunk-loss logging).
 *  session_uid is inv.connectionId — the server resolves the eager-created MeetingSession by it. */
function defaultChunkUploader(inv: Invocation, log: (m: string) => void): ChunkUploader {
  const url = inv.recordingUploadUrl;
  const meetingId = inv.meeting_id ?? 0;
  const sessionUid = inv.connectionId ?? '';
  const token = inv.internalSecret ?? '';
  const svc = new RecordingService(meetingId, sessionUid);
  return async (seq, isFinal, format, bytes) => {
    if (!url) {
      log(`recording: no recordingUploadUrl — chunk ${seq} (${bytes.length}B, isFinal=${isFinal}) NOT uploaded`);
      return;
    }
    // Do not make a second application-owned copy while the sink is intentionally retaining this
    // admitted chunk. The sink keeps `bytes` reserved until this upload settles.
    await svc.uploadChunk(url, token, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), seq, isFinal, format);
  };
}

/**
 * Build the recording sink. Each chunk(...) uploads immediately (serialized in seq order); close(key)
 * sends the empty is_final fallback exactly once if the tap never delivered its own final chunk.
 */
export function createBotRecordingSink(opts: RecordingSinkOptions): BotRecordingSink {
  const log = opts.log ?? (() => { /* silent by default */ });
  const upload = opts.uploadChunk ?? defaultChunkUploader(opts.inv, log);
  const maxRetainedBytes = opts.maxRetainedBytes ?? DEFAULT_MAX_RECORDING_RETAINED_BYTES;
  if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) throw new Error('recording maxRetainedBytes must be a positive integer');

  interface Job {
    seq: number; isFinal: boolean; format: RecordingMasterFormat; bytes: Uint8Array;
    resolve: () => void; reject: (error: Error) => void;
  }
  const jobs: Job[] = [];
  let retainedBytes = 0;
  let uploading = false;
  let closing = false;
  let closed = false;
  let failure: Error | null = null;
  let anyChunk = false;                                // did the tap ever deliver a chunk?
  let finalRequested = false;                          // has an is_final chunk been admitted? (fallback guard)
  let maxSeq = -1;                                     // highest seq seen → the fallback's seq
  let lastFormat: RecordingMasterFormat = 'webm';      // format for the empty-final fallback

  const fail = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const drain = (): void => {
    if (uploading) return;
    const job = jobs.shift();
    if (!job) return;
    uploading = true;
    void (async () => {
      try {
        if (failure) throw failure;
        await upload(job.seq, job.isFinal, job.format, job.bytes);
        job.resolve();
      } catch (error) {
        failure = fail(error);
        job.reject(failure);
        log(`recording: chunk ${job.seq} (isFinal=${job.isFinal}) upload failed: ${failure.message}`);
        // Once durability is uncertain, never send a later final marker that would claim a
        // complete recording. Reject all admitted-but-undelivered chunks and free their bytes.
        for (const pending of jobs.splice(0)) {
          retainedBytes -= pending.bytes.byteLength;
          pending.reject(failure);
        }
      } finally {
        retainedBytes -= job.bytes.byteLength;
        uploading = false;
        drain();
      }
    })();
  };

  const enqueue = (seq: number, isFinal: boolean, format: RecordingMasterFormat, bytes: Uint8Array, allowClosing = false): Promise<void> => {
    if (closed || (closing && !allowClosing)) return Promise.reject(new Error('recording sink is closed'));
    if (failure) throw failure;
    if (bytes.byteLength > maxRetainedBytes) return Promise.reject(new Error(`recording chunk ${seq} exceeds ${maxRetainedBytes}-byte admission budget`));
    // Reservation is synchronous and precedes every await. A caller whose bytes would exceed the
    // budget is rejected before this sink takes ownership; it cannot sit invisibly in a waiter.
    if (retainedBytes + bytes.byteLength > maxRetainedBytes || jobs.length + (uploading ? 1 : 0) >= MAX_QUEUED_RECORDING_CHUNKS) {
      return Promise.reject(new Error(`recording chunk ${seq} rejected: delivery admission budget exhausted`));
    }
    // Publish ingress state synchronously. Browser/MediaRecorder callers may invoke chunk() and
    // close() in the same turn; close must see that already-arrived part and synthesize its final.
    anyChunk = true;
    if (isFinal) finalRequested = true;
    if (seq > maxSeq) maxSeq = seq;
    lastFormat = format;
    retainedBytes += bytes.byteLength;
    const admitted = new Promise<void>((resolve, reject) => jobs.push({ seq, isFinal, format, bytes, resolve, reject }));
    drain();
    return admitted;
  };

  return {
    chunk: (_key, seq, isFinal, format, bytes) => enqueue(seq, isFinal, format, bytes),
    async close(_key) {
      // Final-signal FALLBACK: if the live Stop race dropped the trailing is_final chunk, send one
      // empty is_final so the server flips the recording COMPLETED. No-op for a never-fed session
      // (no phantom recording), and at most once (a real is_final already set finalSent).
      if (closed) {
        if (failure) throw failure;
        return;
      }
      // Freeze ingress before selecting the fallback sequence. All pre-close calls reserve and
      // append synchronously, so the final marker follows them in the serialized queue.
      closing = true;
      if (anyChunk && !finalRequested && !failure) await enqueue(maxSeq + 1, true, lastFormat, new Uint8Array(0), true);
      closed = true;
      // A failing upload rejects close truthfully. Polling is only lifecycle observation; no
      // caller bytes are parked outside `retainedBytes` while this waits.
      while ((uploading || jobs.length) && !failure) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (failure) throw failure;
    },
    resourceCounts() {
      return { retainedBytes, queuedChunks: jobs.length + (uploading ? 1 : 0), failed: !!failure };
    },
  };
}
