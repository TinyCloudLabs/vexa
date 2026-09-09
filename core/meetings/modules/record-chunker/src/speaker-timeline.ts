/** Small recording-clock metadata; no audio samples or DOM references are retained. */
export interface SpeakerInterval {
  start_ms: number;
  end_ms: number;
  participant_id: string | null;
  name: string | null;
  attribution: 'identified' | 'unknown' | 'overlap';
}

export interface SpeakerTimelineChunk {
  version: 1;
  recording_started_at_ms: number;
  intervals: SpeakerInterval[];
  capped: boolean;
}

export interface SpeakingParticipant { id: string; name: string | null }

/** Collect short, coalesced intervals between recording uploads. Evidence expires after a
 * bounded observation gap. If delivery is delayed enough to fill the metadata budget, the
 * remaining window becomes unknown until drain; overflow can never retain more entries.
 */
export function createSpeakerTimeline(opts: { maxIntervals?: number; staleMs?: number } = {}) {
  const max = opts.maxIntervals ?? 256;
  const staleMs = opts.staleMs ?? 750;
  if (!Number.isSafeInteger(max) || max < 2 || max > 256) throw new Error('Invalid timeline budget');
  if (!Number.isFinite(staleMs) || staleMs <= 0 || staleMs > 2000) throw new Error('Invalid timeline expiry');
  let origin: number | null = null;
  let cursor = 0;
  let expires = 0;
  let state: Omit<SpeakerInterval, 'start_ms' | 'end_ms'> = unknown();
  let intervals: SpeakerInterval[] = [];
  let capped = false;

  function unknown(): Omit<SpeakerInterval, 'start_ms' | 'end_ms'> {
    return { participant_id: null, name: null, attribution: 'unknown' };
  }
  function append(start: number, end: number, identity: typeof state) {
    if (end <= start) return;
    if (capped) { intervals[intervals.length - 1]!.end_ms = end; return; }
    const last = intervals[intervals.length - 1];
    if (last && last.end_ms === start && last.attribution === identity.attribution &&
      last.participant_id === identity.participant_id && last.name === identity.name) last.end_ms = end;
    else if (intervals.length < max - 1) intervals.push({ start_ms: start, end_ms: end, ...identity });
    else {
      capped = true;
      intervals.push({ start_ms: start, end_ms: end, ...unknown() });
    }
  }
  function advance(at: number): boolean {
    if (origin === null || !Number.isFinite(at)) return false;
    const end = Math.round(at - origin);
    if (end < cursor) { state = unknown(); expires = cursor; return false; }
    const knownUntil = Math.max(cursor, Math.min(end, expires));
    append(cursor, knownUntil, state);
    append(knownUntil, end, unknown());
    cursor = end;
    return true;
  }
  return {
    start(at: number) {
      if (origin !== null) return;
      if (!Number.isFinite(at) || at <= 0) throw new Error('Invalid recording clock origin');
      origin = at;
    },
    observe(at: number, participants: readonly SpeakingParticipant[], energetic: boolean) {
      if (!advance(at)) return;
      state = unknown();
      if (energetic) {
        const unique = new Map<string, string | null>();
        for (const p of participants) {
          if (!p.id || p.id.length > 256) continue;
          const name = p.name?.trim() || null;
          // Contradictory duplicate tiles cannot establish a name.
          unique.set(p.id, unique.has(p.id) && unique.get(p.id) !== name ? null : name);
        }
        if (unique.size > 1) state = { ...unknown(), attribution: 'overlap' };
        else if (unique.size === 1) {
          const [id, name] = unique.entries().next().value!;
          if (name && name.length <= 256) state = { participant_id: id, name, attribution: 'identified' };
        }
      }
      expires = cursor + staleMs;
    },
    drain(at: number): SpeakerTimelineChunk | undefined {
      if (!advance(at) || origin === null) return undefined;
      const chunk: SpeakerTimelineChunk = { version: 1, recording_started_at_ms: origin, intervals, capped };
      intervals = [];
      capped = false;
      return chunk;
    },
    get pendingIntervals() { return intervals.length; },
  };
}
