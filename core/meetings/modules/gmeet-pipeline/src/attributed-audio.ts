/** Capture-owned, durable attributed-audio.v1 evidence. */
import { createHash } from 'node:crypto';

export const ATTRIBUTED_AUDIO_VERSION = 1;
export const DEFAULT_PCM_BUDGET_BYTES = 32 * 1024 * 1024;
export type Attribution = { source: 'glow-bound' | 'provisional' | 'unresolved'; confidence: number };

export interface AttributedAudioRange {
  version: 1; meeting_id: string; sequence: number; idempotency_key: string;
  /** Channel + generation is evidence identity; a display name is never an identity. */
  speaker_key: string; speaker_name: string; channel: number; turn_generation: number;
  attribution: Attribution; clock_origin_ms: number; start_ms: number; end_ms: number;
  codec: 'pcm_f32le'; sample_rate: number; channels: 1; byte_count: number; sha256: string;
  state: 'sealed' | 'uploaded' | 'failed'; path?: string;
}
export interface AttributedAudioManifest {
  version: 1; meeting_id: string; clock_origin: 'first_admitted_capture_epoch_ms';
  /** Concrete epoch: all range timestamps are relative to it. */
  clock_origin_ms: number; state: 'open' | 'closed'; ranges: AttributedAudioRange[];
}
export interface AttributedAudioStore {
  put(range: Omit<AttributedAudioRange, 'state' | 'path'>, pcm: Uint8Array): Promise<{ path: string }>;
  save(manifest: AttributedAudioManifest): Promise<void>;
  close(manifest: AttributedAudioManifest): Promise<void>;
}
type SealInput = Omit<AttributedAudioRange, 'version' | 'meeting_id' | 'sequence' | 'idempotency_key' | 'clock_origin_ms' | 'byte_count' | 'sha256' | 'state'> & { idempotency_key?: string; byte_count?: number; sha256?: string };

/** Reserve before a byte can be released; `fail` preserves a budget outcome durably. */
export function createAttributedAudioSink(meetingId: string, store: AttributedAudioStore, budgetBytes = DEFAULT_PCM_BUDGET_BYTES) {
  const manifest: AttributedAudioManifest = {
    version: 1, meeting_id: meetingId, clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [],
  };
  let bufferedBytes = 0, nextSequence = 0, closing = false, closed = false;
  const admitted = new Map<string, Promise<AttributedAudioRange>>();
  const snapshot = () => structuredClone(manifest);
  const persist = () => store.save(snapshot());
  const reserve = (input: SealInput, byteCount: number, sha256: string) => {
    if (closing || closed) throw new Error('attributed-audio manifest is closed');
    const idempotency_key = input.idempotency_key ?? `${meetingId}:${input.speaker_key}:${input.turn_generation}:${input.start_ms}:${input.end_ms}`;
    const duplicate = admitted.get(idempotency_key);
    if (duplicate) return { duplicate, range: undefined as never };
    const range: Omit<AttributedAudioRange, 'state' | 'path'> = {
      ...input, version: 1, meeting_id: meetingId, clock_origin_ms: manifest.clock_origin_ms,
      sequence: nextSequence++, idempotency_key, byte_count: byteCount, sha256,
    };
    manifest.ranges.push({ ...range, state: 'sealed' });
    return { duplicate: undefined, range };
  };
  const complete = async (range: Omit<AttributedAudioRange, 'state' | 'path'>, pcm?: Uint8Array): Promise<AttributedAudioRange> => {
    const entry = manifest.ranges.find(value => value.idempotency_key === range.idempotency_key)!;
    try {
      await persist();
      if (!pcm) throw new Error('attributed-audio admission exceeded PCM budget');
      const receipt = await store.put(range, pcm);
      entry.state = 'uploaded'; entry.path = receipt.path;
      await persist();
      return structuredClone(entry);
    } catch (error) {
      // A retry can never regress an upload that won a concurrent race.
      if (entry.state !== 'uploaded') { entry.state = 'failed'; delete entry.path; await persist(); }
      throw error;
    } finally { if (pcm) bufferedBytes -= pcm.byteLength; }
  };
  const admit = (input: SealInput, pcm?: Uint8Array) => {
    const byteCount = pcm?.byteLength ?? input.byte_count;
    if (!Number.isInteger(byteCount) || byteCount === undefined || byteCount < 0) throw new Error('invalid attributed-audio byte count');
    const sha256 = pcm ? createHash('sha256').update(pcm).digest('hex') : (input.sha256 ?? '0'.repeat(64));
    const reserved = reserve(input, byteCount, sha256);
    if (reserved.duplicate) return reserved.duplicate;
    if (pcm) {
      if (bufferedBytes + pcm.byteLength > budgetBytes) throw new Error('attributed-audio PCM budget exceeded before durable handoff');
      bufferedBytes += pcm.byteLength;
    }
    const task = complete(reserved.range, pcm);
    admitted.set(reserved.range.idempotency_key, task);
    return task;
  };
  return {
    manifest: snapshot,
    setClockOrigin(epochMs: number) {
      if (!Number.isFinite(epochMs) || manifest.ranges.length) throw new Error('invalid or late attributed-audio clock origin');
      manifest.clock_origin_ms = epochMs;
    },
    seal(input: SealInput, pcm: Float32Array) { return admit(input, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)); },
    fail(input: SealInput & { byte_count: number; sha256: string }) { return admit(input); },
    async close() {
      if (closed) return snapshot();
      closing = true;
      await Promise.allSettled([...admitted.values()]);
      manifest.state = 'closed';
      try { await persist(); await store.close(snapshot()); closed = true; return snapshot(); }
      catch (error) { manifest.state = 'open'; throw error; }
    },
    bufferedBytes: () => bufferedBytes,
  };
}

export interface AttributedAudioFrame {
  channel: number; speaker_name: string; speaker_key: string; attribution: Attribution;
  pcm: Float32Array; capture_ms: number; sample_rate: number; channels?: 1;
}
type Active = Omit<AttributedAudioFrame, 'pcm' | 'capture_ms'> & {
  generation: number; start_ms: number; end_ms: number; chunks: Float32Array[]; bytes: number; idle?: ReturnType<typeof setTimeout>;
};

/** One serialized admission lane with independent, gap-aware channel turns. */
export function createAttributedAudioRecorder(meetingId: string, store: AttributedAudioStore, options: { cadenceMs?: number; budgetBytes?: number; gapMs?: number } = {}) {
  const cadenceMs = options.cadenceMs ?? 10_000;
  if (cadenceMs < 5_000 || cadenceMs > 15_000) throw new Error('attributed-audio cadence must be 5–15 seconds');
  const budgetBytes = options.budgetBytes ?? DEFAULT_PCM_BUDGET_BYTES;
  const gapMs = options.gapMs ?? 250;
  const sink = createAttributedAudioSink(meetingId, store, budgetBytes);
  const active = new Map<number, Active>();
  const generation = new Map<number, number>();
  let origin: number | undefined, stopping = false, feedTail = Promise.resolve(), assemblingBytes = 0, pendingBytes = 0;
  const relative = (ms: number) => { if (origin === undefined) { origin = ms; sink.setClockOrigin(ms); } return ms - origin; };
  const identity = (frame: AttributedAudioFrame) => `${frame.speaker_key}\u0000${frame.speaker_name}\u0000${frame.attribution.source}\u0000${frame.attribution.confidence}\u0000${frame.sample_rate}\u0000${frame.channels ?? 1}`;
  const activeIdentity = (value: Active) => `${value.speaker_key}\u0000${value.speaker_name}\u0000${value.attribution.source}\u0000${value.attribution.confidence}\u0000${value.sample_rate}\u0000${value.channels ?? 1}`;
  const flush = async (channel: number) => {
    const value = active.get(channel); if (!value) return;
    active.delete(channel); if (value.idle) clearTimeout(value.idle);
    assemblingBytes += value.bytes;
    const samples = new Float32Array(value.bytes / Float32Array.BYTES_PER_ELEMENT);
    let offset = 0; for (const chunk of value.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    value.chunks.length = 0; assemblingBytes -= value.bytes;
    await sink.seal({ speaker_key: value.speaker_key, speaker_name: value.speaker_name, channel,
      turn_generation: value.generation, attribution: value.attribution, start_ms: value.start_ms, end_ms: value.end_ms,
      codec: 'pcm_f32le', sample_rate: value.sample_rate, channels: value.channels ?? 1 }, samples);
  };
  const armIdle = (channel: number, value: Active) => {
    if (value.idle) clearTimeout(value.idle);
    value.idle = setTimeout(() => { feedTail = feedTail.then(() => flush(channel)); }, cadenceMs);
  };
  const process = async (frame: AttributedAudioFrame) => {
    if (!Number.isFinite(frame.capture_ms) || !Number.isInteger(frame.channel) || frame.channel < 0 || frame.sample_rate <= 0) throw new Error('invalid attributed-audio frame');
    if (!frame.pcm.length) return;
    const start = relative(frame.capture_ms), end = start + (frame.pcm.length / frame.sample_rate) * 1000;
    let value = active.get(frame.channel);
    if (value && (activeIdentity(value) !== identity(frame) || start > value.end_ms + gapMs)) await flush(frame.channel);
    value = active.get(frame.channel);
    if (!value) {
      const next = (generation.get(frame.channel) ?? 0) + 1; generation.set(frame.channel, next);
      value = { channel: frame.channel, speaker_key: frame.speaker_key || `channel:${frame.channel}`, speaker_name: frame.speaker_name,
        attribution: frame.attribution, sample_rate: frame.sample_rate, channels: frame.channels ?? 1, generation: next,
        start_ms: start, end_ms: start, chunks: [], bytes: 0 };
      active.set(frame.channel, value);
    }
    const bytes = frame.pcm.byteLength;
    // At seal time the aggregate temporarily duplicates the turn. Keep the active half of what
    // remains after in-flight bytes so chunks + aggregate + upload can never cross the budget.
    if (sink.bufferedBytes() + value.bytes + bytes + (value.bytes + bytes) > budgetBytes) {
      const failed = { speaker_key: value.speaker_key, speaker_name: value.speaker_name, channel: frame.channel, turn_generation: value.generation,
        attribution: value.attribution, start_ms: start, end_ms: end, codec: 'pcm_f32le' as const, sample_rate: frame.sample_rate, channels: 1 as const,
        byte_count: bytes, sha256: createHash('sha256').update(new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, bytes)).digest('hex') };
      active.delete(frame.channel); if (value.idle) clearTimeout(value.idle);
      await sink.fail(failed).catch(() => undefined);
      throw new Error('attributed-audio PCM budget exceeded; durable failed outcome recorded');
    }
    value.chunks.push(frame.pcm); value.bytes += bytes; value.end_ms = end;
    if (end - value.start_ms >= cadenceMs) await flush(frame.channel); else armIdle(frame.channel, value);
  };
  return {
    feed(frame: AttributedAudioFrame): Promise<void> {
      if (stopping) return Promise.reject(new Error('attributed-audio recorder is stopped'));
      const bytes = frame.pcm.byteLength;
      // Count bytes at the Node boundary, before a serialized callback waits behind another upload.
      // A rejected admission gets a durable failed row once it reaches the serialized ledger lane.
      const overBudget = sink.bufferedBytes() + assemblingBytes + pendingBytes + [...active.values()].reduce((n, value) => n + value.bytes, 0) + bytes > budgetBytes;
      pendingBytes += bytes;
      const task = feedTail.then(async () => {
        pendingBytes -= bytes;
        if (!overBudget) return process(frame);
        const start = relative(frame.capture_ms), end = start + (frame.pcm.length / frame.sample_rate) * 1000;
        const turn = (generation.get(frame.channel) ?? 0) + 1; generation.set(frame.channel, turn);
        await sink.fail({ speaker_key: frame.speaker_key || `channel:${frame.channel}`, speaker_name: frame.speaker_name,
          channel: frame.channel, turn_generation: turn, attribution: frame.attribution, start_ms: start, end_ms: end,
          codec: 'pcm_f32le', sample_rate: frame.sample_rate, channels: 1, byte_count: bytes,
          sha256: createHash('sha256').update(new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, bytes)).digest('hex')
        }).catch(() => undefined);
        throw new Error('attributed-audio PCM budget exceeded; durable failed outcome recorded');
      });
      feedTail = task.catch(() => undefined);
      return task;
    },
    async stop(): Promise<AttributedAudioManifest> {
      stopping = true; await feedTail;
      await Promise.all([...active.keys()].map(flush));
      return sink.close();
    },
    retainedBytes: () => sink.bufferedBytes() + assemblingBytes + pendingBytes + [...active.values()].reduce((n, v) => n + v.bytes, 0),
  };
}
