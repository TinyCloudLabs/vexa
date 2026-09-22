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
  url?: string;
}

export interface AttributedAudioManifest {
  version: 1;
  meeting_id: string;
  state: 'open' | 'closed';
  ranges: AttributedAudioRange[];
}

export interface AttributedAudioStore {
  /** Durably write bytes and return their immutable retrieval URL before this promise resolves. */
  put(range: Omit<AttributedAudioRange, 'state' | 'url'>, pcm: Uint8Array): Promise<{ url: string }>;
  /** Persist the manifest/range ledger. This is distinct from object storage: a failed upload is
   * evidence too, and must survive before a later close can publish the manifest. */
  save(manifest: AttributedAudioManifest): Promise<void>;
  close(manifest: AttributedAudioManifest): Promise<void>;
}

/** A tiny bounded capture sink used by the GMeet adapter instead of retaining PCM behind STT admission. */
export function createAttributedAudioSink(meetingId: string, store: AttributedAudioStore, budgetBytes = DEFAULT_PCM_BUDGET_BYTES) {
  const manifest: AttributedAudioManifest = { version: 1, meeting_id: meetingId, state: 'open', ranges: [] };
  let bufferedBytes = 0;
  let nextSequence = 0;
  let closing = false;
  let closed = false;
  const admitted = new Map<string, Promise<AttributedAudioRange>>();

  const snapshot = () => structuredClone(manifest);
  const persist = () => store.save(snapshot());
  return {
    manifest: snapshot,
    async seal(input: Omit<AttributedAudioRange, 'version' | 'meeting_id' | 'sequence' | 'byte_count' | 'sha256' | 'state'> & { idempotency_key?: string }, pcm: Float32Array): Promise<AttributedAudioRange> {
      if (closing || closed) throw new Error('attributed-audio manifest is closed');
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      if (bufferedBytes + bytes.byteLength > budgetBytes) throw new Error('attributed-audio PCM budget exceeded before durable handoff');
      const idempotency_key = input.idempotency_key ?? `${meetingId}:${input.speaker_key}:${input.start_ms}:${input.end_ms}`;
      const duplicate = admitted.get(idempotency_key);
      if (duplicate) return duplicate;
      const sequence = nextSequence++;
      const range: Omit<AttributedAudioRange, 'state' | 'url'> = {
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
          entry.url = persisted.url;
          await persist();
          return structuredClone(entry);
        } catch (error) {
          entry.state = 'failed';
          delete entry.url;
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
