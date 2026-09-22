/** Capture-owned, durable attributed-audio.v1 evidence. */
import { createHash } from 'node:crypto';

export const ATTRIBUTED_AUDIO_VERSION = 1;
export const DEFAULT_PCM_BUDGET_BYTES = 32 * 1024 * 1024;
/** Public attributed-audio.v1 maximum callback scheduling gap; larger gaps form a new range. */
export const ATTRIBUTED_AUDIO_MAX_CALLBACK_GAP_MS = 250;
const MAX_CHANNELS = 64;
/** A missing row is metadata, but it still has to fit the HTTP body's hard limit. */
const MAX_MISSING_BYTES = 32 * 1024 * 1024;
export type Attribution = { source: 'glow-bound' | 'provisional' | 'unresolved'; confidence: number };

export interface AttributedAudioRange {
  version: 1; meeting_id: string; sequence: number; idempotency_key: string;
  speaker_key: string; speaker_name: string; channel: number; turn_generation: number;
  attribution: Attribution; clock_origin_ms: number; start_ms: number; end_ms: number;
  /** Sample time validates bytes; wall time places audio, including legitimate capture gaps. */
  audio_duration_ms: number;
  codec: 'pcm_f32le'; sample_rate: number; channels: 1; byte_count: number; sha256: string;
  state: 'sealed' | 'uploaded' | 'failed'; path?: string;
}
export interface AttributedAudioManifest {
  version: 1; meeting_id: string; clock_origin: 'first_admitted_capture_epoch_ms';
  clock_origin_ms: number; state: 'open' | 'closed'; ranges: AttributedAudioRange[];
}
type ImmutableRange = Omit<AttributedAudioRange, 'state' | 'path'>;
export interface AttributedAudioStore {
  reserve(range: ImmutableRange): Promise<AttributedAudioRange>;
  upload(range: ImmutableRange, pcm: readonly Uint8Array[]): Promise<{ path: string }>;
  fail(range: ImmutableRange): Promise<AttributedAudioRange>;
  close(manifest: AttributedAudioManifest): Promise<void>;
  load?(): Promise<AttributedAudioManifest>;
}
type SealInput = Omit<ImmutableRange, 'version' | 'meeting_id' | 'sequence' | 'idempotency_key' | 'clock_origin_ms' | 'byte_count' | 'sha256' | 'audio_duration_ms'> & {
  idempotency_key?: string; byte_count?: number; sha256?: string; audio_duration_ms?: number;
};

const clone = <T>(value: T): T => structuredClone(value);
const digest = (chunks: readonly Uint8Array[]) => {
  const hash = createHash('sha256'); for (const chunk of chunks) hash.update(chunk); return hash.digest('hex');
};

/** A bounded durable handoff. PCM belongs to a task only after its admission succeeds. */
export function createAttributedAudioSink(meetingId: string, store: AttributedAudioStore, budgetBytes = DEFAULT_PCM_BUDGET_BYTES) {
  let manifest: AttributedAudioManifest = { version: 1, meeting_id: meetingId, clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] };
  let bufferedBytes = 0, nextSequence = 0, closing = false, closed = false, initialized = !store.load;
  const tasks = new Map<string, { range: ImmutableRange; task: Promise<AttributedAudioRange> }>();
  const sameImmutable = (left: ImmutableRange, right: ImmutableRange) =>
    Object.keys(left).filter(key => key !== 'attribution' && key !== 'state' && key !== 'path').every(key =>
      (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key])
    && JSON.stringify(left.attribution) === JSON.stringify(right.attribution);
  const replace = (range: AttributedAudioRange) => {
    const index = manifest.ranges.findIndex(value => value.idempotency_key === range.idempotency_key);
    if (index >= 0) manifest.ranges[index] = clone(range); else manifest.ranges.push(clone(range));
  };
  // Constructing a retry must not allocate an identity.  In particular, callers commonly retry
  // while the first reserve is in flight; consuming a sequence for that comparison creates a
  // fictional gap in the durable ledger.
  const immutable = (input: SealInput, byteCount: number, sha256: string, audioDurationMs: number, sequence: number): ImmutableRange => ({
    ...input, version: 1, meeting_id: meetingId, sequence,
    idempotency_key: input.idempotency_key ?? `${meetingId}:${input.speaker_key}:${input.turn_generation}:${input.start_ms}:${input.end_ms}`,
    clock_origin_ms: manifest.clock_origin_ms, byte_count: byteCount, sha256, audio_duration_ms: audioDurationMs,
  });
  const run = (range: ImmutableRange, pcm?: readonly Uint8Array[]) => {
    const bytes = pcm?.reduce((total, chunk) => total + chunk.byteLength, 0) ?? 0;
    const task = (async () => {
      try {
        const reserved = await store.reserve(range); replace(reserved);
        if (!pcm) { const failed = await store.fail(range); replace(failed); return failed; }
        try {
          const receipt = await store.upload(range, pcm);
          const uploaded = { ...range, state: 'uploaded' as const, path: receipt.path }; replace(uploaded); return uploaded;
        } catch (error) {
          try { const failed = await store.fail(range); replace(failed); } catch { /* close exposes unresolved reservation */ }
          throw error;
        }
      } catch (error) {
        // A failed reservation never owns PCM. Keep a local failed row so close remains an
        // observable incomplete outcome; a later restart/retry can durably reserve this key.
        const failed = { ...range, state: 'failed' as const }; replace(failed);
        throw error;
      } finally { bufferedBytes -= bytes; }
    })();
    tasks.set(range.idempotency_key, { range, task });
    void task.finally(() => tasks.delete(range.idempotency_key)).catch(() => undefined);
    return task;
  };
  const reconcile = async () => {
    if (!store.load) return;
    const loaded = await store.load();
    if (loaded.meeting_id !== meetingId || loaded.state !== 'open') throw new Error('attributed-audio manifest is not an open manifest for this meeting');
    manifest = clone(loaded); nextSequence = Math.max(0, ...manifest.ranges.map(range => range.sequence + 1));
    // A restart has no reserved PCM. Preserve its evidence as a durable missing outcome.
    for (const range of manifest.ranges.filter(value => value.state === 'sealed')) run({ ...range, state: undefined, path: undefined } as ImmutableRange);
  };
  const ready = reconcile().finally(() => { initialized = true; });
  const admit = (input: SealInput, pcm?: readonly Uint8Array[]) => {
    if (!initialized) throw new Error('attributed-audio recorder is reconciling');
    if (closing || closed) throw new Error('attributed-audio manifest is closed');
    const byteCount = pcm ? pcm.reduce((total, chunk) => total + chunk.byteLength, 0) : input.byte_count;
    if (!Number.isInteger(byteCount) || byteCount === undefined || byteCount < 0) throw new Error('invalid attributed-audio byte count');
    const audioDurationMs = input.audio_duration_ms ?? (byteCount / 4 / input.sample_rate) * 1000;
    if (!Number.isFinite(audioDurationMs) || audioDurationMs < 0) throw new Error('invalid attributed-audio duration');
    const sha256 = pcm ? digest(pcm) : (input.sha256 ?? '0'.repeat(64));
    const key = input.idempotency_key ?? `${meetingId}:${input.speaker_key}:${input.turn_generation}:${input.start_ms}:${input.end_ms}`;
    const duplicate = tasks.get(key);
    if (duplicate) {
      const proposed = immutable(input, byteCount, sha256, audioDurationMs, duplicate.range.sequence);
      if (!sameImmutable(duplicate.range, proposed)) throw new Error('attributed-audio idempotency key conflicts with pending payload');
      return duplicate.task;
    }
    const prior = manifest.ranges.find(value => value.idempotency_key === key);
    if (prior) {
      const proposed = immutable(input, byteCount, sha256, audioDurationMs, prior.sequence);
      if (!sameImmutable(prior as ImmutableRange, proposed)) throw new Error('attributed-audio idempotency key conflicts with durable ledger');
      return Promise.resolve(clone(prior));
    }
    if (pcm) { if (bufferedBytes + byteCount > budgetBytes) throw new Error('attributed-audio PCM budget exceeded before durable handoff'); bufferedBytes += byteCount; }
    const range = immutable(input, byteCount, sha256, audioDurationMs, nextSequence++);
    manifest.ranges.push({ ...range, state: 'sealed' });
    return run(range, pcm);
  };
  return {
    manifest: () => clone(manifest), ready,
    setClockOrigin(epochMs: number) { if (!Number.isFinite(epochMs) || manifest.ranges.length) throw new Error('invalid or late attributed-audio clock origin'); manifest.clock_origin_ms = epochMs; },
    seal(input: SealInput, chunks: readonly Float32Array[]) { return admit(input, chunks.map(chunk => new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))); },
    fail(input: SealInput & { byte_count: number; sha256: string; audio_duration_ms: number }) { return admit(input); },
    async close() {
      if (closed) return clone(manifest); closing = true;
      await Promise.allSettled([...tasks.values()].map(value => value.task));
      if (manifest.ranges.some(range => range.state === 'sealed')) throw new Error('attributed-audio ranges lack a durable outcome');
      const closingManifest = { ...clone(manifest), state: 'closed' as const };
      await store.close(closingManifest); manifest = closingManifest; closed = true; return clone(manifest);
    },
    bufferedBytes: () => bufferedBytes, taskCount: () => tasks.size,
  };
}

export interface AttributedAudioFrame {
  channel: number; speaker_name: string; speaker_key: string; attribution: Attribution;
  pcm: Float32Array; capture_ms: number; sample_rate: number; channels?: 1;
}
type Active = Omit<AttributedAudioFrame, 'pcm' | 'capture_ms'> & { generation: number; start_ms: number; end_ms: number; audio_duration_ms: number; chunks: Float32Array[]; bytes: number; idle?: ReturnType<typeof setTimeout> };
type Missing = Omit<SealInput, 'byte_count' | 'sha256' | 'audio_duration_ms'> & { byte_count: number; audio_duration_ms: number };

/** Per-channel bounded capture buffers. Feed admits or rejects synchronously and never queues PCM. */
export function createAttributedAudioRecorder(meetingId: string, store: AttributedAudioStore, options: { cadenceMs?: number; budgetBytes?: number; gapMs?: number } = {}) {
  const cadenceMs = options.cadenceMs ?? 10_000;
  if (cadenceMs < 5_000 || cadenceMs > 15_000) throw new Error('attributed-audio cadence must be 5–15 seconds');
  const budgetBytes = options.budgetBytes ?? DEFAULT_PCM_BUDGET_BYTES,
    gapMs = Math.min(options.gapMs ?? ATTRIBUTED_AUDIO_MAX_CALLBACK_GAP_MS, ATTRIBUTED_AUDIO_MAX_CALLBACK_GAP_MS);
  const sink = createAttributedAudioSink(meetingId, store, budgetBytes);
  const active = new Map<number, Active>(), missing = new Map<number, Missing>(), generation = new Map<number, number>();
  let origin: number | undefined, stopping = false;
  const relative = (ms: number) => { if (origin === undefined) { origin = ms; sink.setClockOrigin(ms); } return ms - origin; };
  const activeBytes = () => [...active.values()].reduce((total, value) => total + value.bytes, 0);
  const identity = (frame: AttributedAudioFrame) => `${frame.speaker_key}\u0000${frame.speaker_name}\u0000${frame.attribution.source}\u0000${frame.attribution.confidence}\u0000${frame.sample_rate}\u0000${frame.channels ?? 1}`;
  const activeIdentity = (value: Active) => `${value.speaker_key}\u0000${value.speaker_name}\u0000${value.attribution.source}\u0000${value.attribution.confidence}\u0000${value.sample_rate}\u0000${value.channels ?? 1}`;
  const flush = (channel: number) => {
    const value = active.get(channel); if (!value) return; active.delete(channel); if (value.idle) clearTimeout(value.idle);
    void sink.seal({ speaker_key: value.speaker_key, speaker_name: value.speaker_name, channel, turn_generation: value.generation, attribution: value.attribution,
      start_ms: value.start_ms, end_ms: value.end_ms, audio_duration_ms: value.audio_duration_ms, codec: 'pcm_f32le', sample_rate: value.sample_rate, channels: value.channels ?? 1 }, value.chunks).catch(() => undefined);
    value.chunks = [];
  };
  const flushMissing = (channel: number) => {
    const value = missing.get(channel); if (!value) return; missing.delete(channel);
    void sink.fail({ ...value, idempotency_key: `${meetingId}:missing:${value.speaker_key}:${value.turn_generation}:${value.start_ms}:${value.end_ms}`, sha256: '0'.repeat(64) }).catch(() => undefined);
  };
  const recordMissing = (frame: AttributedAudioFrame, start: number, end: number) => {
    let value = missing.get(frame.channel);
    const matching = value && value.speaker_key === (frame.speaker_key || `channel:${frame.channel}`) && value.sample_rate === frame.sample_rate;
    if (!matching) {
      if (value) flushMissing(frame.channel); if (missing.size >= MAX_CHANNELS) return;
      const turn = (generation.get(frame.channel) ?? 0) + 1; generation.set(frame.channel, turn);
      value = { speaker_key: frame.speaker_key || `channel:${frame.channel}`, speaker_name: frame.speaker_name, channel: frame.channel, turn_generation: turn,
        attribution: frame.attribution, start_ms: start, end_ms: end, codec: 'pcm_f32le', sample_rate: frame.sample_rate, channels: 1, byte_count: 0, audio_duration_ms: 0 };
      missing.set(frame.channel, value);
    }
    if (!value) return;
    // Split, never grow a missing row past the server's request validator. The incoming frame
    // normally fits this bound; an oversized callback is represented as several truthful rows.
    if (value.byte_count && value.byte_count + frame.pcm.byteLength > MAX_MISSING_BYTES) {
      flushMissing(frame.channel);
      recordMissing(frame, start, end);
      return;
    }
    value.byte_count += frame.pcm.byteLength; value.audio_duration_ms += frame.pcm.length / frame.sample_rate * 1000; value.end_ms = end;
  };
  const ready = sink.ready.then(() => {
    const prior = sink.manifest(); origin = prior.ranges.length ? prior.clock_origin_ms : undefined;
    for (const range of prior.ranges) generation.set(range.channel, Math.max(generation.get(range.channel) ?? 0, range.turn_generation));
  });
  const feed = (frame: AttributedAudioFrame): void => {
    if (stopping) throw new Error('attributed-audio recorder is stopped');
    if (!Number.isFinite(frame.capture_ms) || !Number.isInteger(frame.channel) || frame.channel < 0 || frame.sample_rate <= 0) throw new Error('invalid attributed-audio frame');
    if (!frame.pcm.length) return;
    const start = relative(frame.capture_ms), end = start + frame.pcm.length / frame.sample_rate * 1000;
    let value = active.get(frame.channel);
    if (value && (activeIdentity(value) !== identity(frame) || start > value.end_ms + gapMs)) flush(frame.channel);
    value = active.get(frame.channel);
    if (!value) {
      if (active.size >= MAX_CHANNELS) { recordMissing(frame, start, end); return; }
      const next = (generation.get(frame.channel) ?? 0) + 1; generation.set(frame.channel, next);
      value = { channel: frame.channel, speaker_key: frame.speaker_key || `channel:${frame.channel}`, speaker_name: frame.speaker_name, attribution: frame.attribution,
        sample_rate: frame.sample_rate, channels: frame.channels ?? 1, generation: next, start_ms: start, end_ms: start, audio_duration_ms: 0, chunks: [], bytes: 0 }; active.set(frame.channel, value);
    }
    if (sink.bufferedBytes() + activeBytes() + frame.pcm.byteLength > budgetBytes) {
      // Do not leave an empty active turn behind: it would later become a zero-byte uploaded
      // range and falsely make an over-budget capture look complete.
      if (value.bytes === 0) active.delete(frame.channel);
      recordMissing(frame, start, end);
      return;
    }
    value.chunks.push(frame.pcm); value.bytes += frame.pcm.byteLength; value.audio_duration_ms += frame.pcm.length / frame.sample_rate * 1000; value.end_ms = end;
    if (end - value.start_ms >= cadenceMs) flush(frame.channel);
    else { if (value.idle) clearTimeout(value.idle); value.idle = setTimeout(() => flush(frame!.channel), cadenceMs); }
  };
  return {
    feed, ready,
    /** A page-side admission fence stopped capture before its PCM crossed into Node.  Record the
     * loss as a durable failed range rather than pretending that a complete manifest exists. */
    incomplete(frame: Omit<AttributedAudioFrame, 'pcm'>): Promise<AttributedAudioRange> {
      const start = relative(frame.capture_ms);
      const turn = (generation.get(frame.channel) ?? 0) + 1; generation.set(frame.channel, turn);
      return sink.fail({
        idempotency_key: `${meetingId}:page-boundary:${frame.channel}:${turn}:${start}`,
        speaker_key: frame.speaker_key || `channel:${frame.channel}`, speaker_name: frame.speaker_name,
        channel: frame.channel, turn_generation: turn, attribution: frame.attribution,
        start_ms: start, end_ms: start, audio_duration_ms: 0, codec: 'pcm_f32le',
        sample_rate: frame.sample_rate, channels: 1, byte_count: 0, sha256: '0'.repeat(64),
      });
    },
    async stop(): Promise<AttributedAudioManifest> { stopping = true; for (const channel of [...active.keys()]) flush(channel); for (const channel of [...missing.keys()]) flushMissing(channel); await sink.ready; return sink.close(); },
    retainedBytes: () => sink.bufferedBytes() + activeBytes(), pendingTasks: () => sink.taskCount(), metadataCount: () => missing.size + active.size,
  };
}
