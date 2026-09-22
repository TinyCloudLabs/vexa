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
  close(manifest: AttributedAudioManifest): Promise<void>;
}

/** A tiny bounded capture sink used by the GMeet adapter instead of retaining PCM behind STT admission. */
export function createAttributedAudioSink(meetingId: string, store: AttributedAudioStore, budgetBytes = DEFAULT_PCM_BUDGET_BYTES) {
  const manifest: AttributedAudioManifest = { version: 1, meeting_id: meetingId, state: 'open', ranges: [] };
  let bufferedBytes = 0;
  let closed = false;
  return {
    manifest: () => structuredClone(manifest),
    async seal(input: Omit<AttributedAudioRange, 'version' | 'meeting_id' | 'sequence' | 'idempotency_key' | 'byte_count' | 'sha256' | 'state'>, pcm: Float32Array): Promise<AttributedAudioRange> {
      if (closed) throw new Error('attributed-audio manifest is closed');
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      if (bufferedBytes + bytes.byteLength > budgetBytes) throw new Error('attributed-audio PCM budget exceeded before durable handoff');
      bufferedBytes += bytes.byteLength;
      const sequence = manifest.ranges.length;
      const idempotency_key = `${meetingId}:${input.speaker_key}:${input.start_ms}:${sequence}`;
      const range: Omit<AttributedAudioRange, 'state' | 'url'> = {
        ...input, version: ATTRIBUTED_AUDIO_VERSION, meeting_id: meetingId, sequence, idempotency_key,
        byte_count: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      try {
        const persisted = await store.put(range, bytes);
        const complete: AttributedAudioRange = { ...range, state: 'uploaded', url: persisted.url };
        manifest.ranges.push(complete);
        return complete;
      } catch (error) {
        manifest.ranges.push({ ...range, state: 'failed' });
        throw error;
      } finally {
        // The caller may now release its Float32Array: persistence completed (or a durable failure is recorded).
        bufferedBytes -= bytes.byteLength;
      }
    },
    async close(): Promise<AttributedAudioManifest> {
      if (!closed) {
        closed = true;
        manifest.state = 'closed';
        await store.close(manifest);
      }
      return structuredClone(manifest);
    },
    bufferedBytes: () => bufferedBytes,
  };
}
