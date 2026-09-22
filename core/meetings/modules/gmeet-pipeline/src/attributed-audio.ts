/**
 * The PTX handoff is deliberately capture-owned: this module seals a range before its PCM can be
 * released.  It does not transcribe and it never guesses a speaker after the fact.
 */
import { createHash } from 'node:crypto';

export const ATTRIBUTED_AUDIO_VERSION = 1;
export const DEFAULT_PCM_BUDGET_BYTES = 32 * 1024 * 1024;

export interface AttributedAudioRange {
  version: 1;
  meeting_id: string;
  sequence: number;
  idempotency_key: string;
  speaker_key: string;
  speaker_name: string;
  attribution: { source: 'glow-bound' | 'provisional'; confidence: number };
  start_ms: number;
  end_ms: number;
  codec: 'pcm_f32le';
  sample_rate: number;
  channels: 1;
  byte_count: number;
  sha256: string;
  state: 'sealed' | 'uploaded' | 'failed';
  /** Authenticated Vexa API path, never an object-store address. */
  path?: string;
}

export interface AttributedAudioManifest {
  version: 1;
  meeting_id: string;
  /** Capture timestamps are milliseconds from this epoch-clock origin. */
  clock_origin: 'capture_epoch_ms';
  state: 'open' | 'closed';
  ranges: AttributedAudioRange[];
}

export interface AttributedAudioStore {
  /** Durably reserve, upload and acknowledge immutable bytes before this promise resolves. */
  put(range: Omit<AttributedAudioRange, 'state' | 'path'>, pcm: Uint8Array): Promise<{ path: string }>;
  /** Persist the manifest/range ledger. This is distinct from object storage: a failed upload is
   * evidence too, and must survive before a later close can publish the manifest. */
  save(manifest: AttributedAudioManifest): Promise<void>;
  close(manifest: AttributedAudioManifest): Promise<void>;
}

/** A tiny bounded capture sink used by the GMeet adapter instead of retaining PCM behind STT admission. */
export function createAttributedAudioSink(meetingId: string, store: AttributedAudioStore, budgetBytes = DEFAULT_PCM_BUDGET_BYTES) {
  const manifest: AttributedAudioManifest = {
    version: 1, meeting_id: meetingId, clock_origin: 'capture_epoch_ms', state: 'open', ranges: [],
  };
  let bufferedBytes = 0;
  let nextSequence = 0;
  let closing = false;
  let closed = false;
  const admitted = new Map<string, Promise<AttributedAudioRange>>();

  const snapshot = () => structuredClone(manifest);
  const persist = () => store.save(snapshot());
  return {
    manifest: snapshot,
    async seal(input: Omit<AttributedAudioRange, 'version' | 'meeting_id' | 'sequence' | 'idempotency_key' | 'byte_count' | 'sha256' | 'state'> & { idempotency_key?: string }, pcm: Float32Array): Promise<AttributedAudioRange> {
      if (closing || closed) throw new Error('attributed-audio manifest is closed');
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      if (bufferedBytes + bytes.byteLength > budgetBytes) throw new Error('attributed-audio PCM budget exceeded before durable handoff');
      const idempotency_key = input.idempotency_key ?? `${meetingId}:${input.speaker_key}:${input.start_ms}:${input.end_ms}`;
      const duplicate = admitted.get(idempotency_key);
      if (duplicate) return duplicate;
      const sequence = nextSequence++;
      const range: Omit<AttributedAudioRange, 'state' | 'path'> = {
        ...input, version: ATTRIBUTED_AUDIO_VERSION, meeting_id: meetingId, sequence, idempotency_key,
        byte_count: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      // Reserve synchronously before any await. A close therefore sees every admitted range and
      // concurrent callers cannot re-use a sequence number.
      const entry: AttributedAudioRange = { ...range, state: 'sealed' };
      manifest.ranges.push(entry);
      bufferedBytes += bytes.byteLength;
      const upload = (async () => {
        try {
          await persist();
          const persisted = await store.put(range, bytes);
          entry.state = 'uploaded';
          entry.path = persisted.path;
          await persist();
          return structuredClone(entry);
        } catch (error) {
          entry.state = 'failed';
          delete entry.path;
          // Do not call an in-memory row durable. If this fails, close retries this exact
          // manifest publication rather than pretending the failure was recorded.
          await persist();
          throw error;
        } finally {
          bufferedBytes -= bytes.byteLength;
        }
      })();
      admitted.set(idempotency_key, upload);
      return upload;
    },
    async close(): Promise<AttributedAudioManifest> {
      if (closed) return snapshot();
      closing = true;
      // Admissions are frozen first, then every previously admitted upload settles. Failed
      // ranges remain in the manifest; none can disappear behind a close race.
      await Promise.allSettled([...admitted.values()]);
      manifest.state = 'closed';
      try {
        await persist();
        await store.close(snapshot());
        closed = true;
        return snapshot();
      } catch (error) {
        // Keep admission closed, but permit retrying manifest publication/close.
        manifest.state = 'open';
        throw error;
      }
    },
    bufferedBytes: () => bufferedBytes,
  };
}

export interface AttributedAudioFrame {
  channel: number;
  speaker_name: string;
  /** Stable capture identity; a channel can be reused after a turn ends. */
  speaker_key: string;
  attribution: { source: 'glow-bound' | 'provisional'; confidence: number };
  pcm: Float32Array;
  capture_ms: number;
  sample_rate: number;
  channels?: 1;
}

/**
 * Canonical GMeet producer.  It lives beside the channel pipeline but has no STT dependency:
 * its only input is the frame at the capture boundary, where channel/name provenance still exists.
 */
export function createAttributedAudioRecorder(
  meetingId: string,
  store: AttributedAudioStore,
  options: { cadenceMs?: number; budgetBytes?: number } = {},
) {
  const cadenceMs = options.cadenceMs ?? 10_000;
  if (cadenceMs < 5_000 || cadenceMs > 15_000) throw new Error('attributed-audio cadence must be 5–15 seconds');
  const budgetBytes = options.budgetBytes ?? DEFAULT_PCM_BUDGET_BYTES;
  const sink = createAttributedAudioSink(meetingId, store, budgetBytes);
  let active: (Omit<AttributedAudioFrame, 'pcm' | 'capture_ms'> & { start_ms: number; end_ms: number; chunks: Float32Array[]; bytes: number }) | undefined;
  let stopped = false;

  const identityOf = (frame: AttributedAudioFrame) =>
    `${frame.channel}\u0000${frame.speaker_key}\u0000${frame.speaker_name}\u0000${frame.attribution.source}\u0000${frame.attribution.confidence}\u0000${frame.sample_rate}\u0000${frame.channels ?? 1}`;
  const activeIdentity = () => active && `${active.channel}\u0000${active.speaker_key}\u0000${active.speaker_name}\u0000${active.attribution.source}\u0000${active.attribution.confidence}\u0000${active.sample_rate}\u0000${active.channels ?? 1}`;
  const flush = async () => {
    if (!active) return;
    const value = active;
    active = undefined;
    const samples = new Float32Array(value.bytes / Float32Array.BYTES_PER_ELEMENT);
    let offset = 0;
    for (const chunk of value.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    await sink.seal({
      speaker_key: value.speaker_key, speaker_name: value.speaker_name, attribution: value.attribution,
      start_ms: value.start_ms, end_ms: value.end_ms, codec: 'pcm_f32le',
      sample_rate: value.sample_rate, channels: value.channels ?? 1,
    }, samples);
  };

  return {
    async feed(frame: AttributedAudioFrame): Promise<void> {
      if (stopped) throw new Error('attributed-audio recorder is stopped');
      if (!frame.speaker_name) return; // An unbound track is not canonical attribution.
      if (!Number.isFinite(frame.capture_ms) || frame.capture_ms < 0) throw new Error('invalid capture timestamp');
      if (!frame.pcm.length) return;
      if (active && activeIdentity() !== identityOf(frame)) await flush();
      if (!active) {
        active = {
          channel: frame.channel, speaker_key: frame.speaker_key, speaker_name: frame.speaker_name,
          attribution: frame.attribution, sample_rate: frame.sample_rate, channels: frame.channels ?? 1,
          start_ms: frame.capture_ms, end_ms: frame.capture_ms, chunks: [], bytes: 0,
        };
      }
      const bytes = frame.pcm.byteLength;
      // Awaiting the seal below is intentional backpressure.  The producer never silently drops
      // PCM just because object storage is slow, and retained PCM stays bounded including the turn.
      if (sink.bufferedBytes() + active.bytes + bytes > budgetBytes) throw new Error('attributed-audio PCM budget exceeded');
      active.chunks.push(frame.pcm.slice());
      active.bytes += bytes;
      active.end_ms = frame.capture_ms + (frame.pcm.length / frame.sample_rate) * 1000;
      if (active.end_ms - active.start_ms >= cadenceMs) await flush();
    },
    async stop(): Promise<AttributedAudioManifest> {
      if (!stopped) { stopped = true; await flush(); }
      return sink.close();
    },
    retainedBytes: () => sink.bufferedBytes() + (active?.bytes ?? 0),
  };
}
