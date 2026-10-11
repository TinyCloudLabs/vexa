/**
 * Remote-media loss detection for the active phase (TC-903).
 *
 * A bot whose WebRTC media is dropped by the platform keeps its seat: the participant tiles stay,
 * the remote audio tracks end, and nothing is ever heard again. To the silence adapter that is
 * indistinguishable from a quiet room, so the bot used to sit deaf for the whole silence window
 * and then leave a meeting that was still running. The truth separating the two is on the page:
 *
 *   | live remote audio tracks | remote participants | truth                          | outcome            |
 *   |--------------------------|---------------------|--------------------------------|--------------------|
 *   | >= 1                     | any                 | hearing (or a quiet room)      | silence window     |
 *   | 0                        | 0                   | room emptied / not in the call | aloneness decides  |
 *   | 0                        | >= 1, < grace       | the platform may re-create them| wait               |
 *   | 0                        | >= 1, >= grace      | cut off from a live meeting    | fire -> rejoin     |
 *
 * Digital silence on a live track is NOT a loss here: a Google Meet audio slot nobody is speaking
 * into delivers zeros exactly like a dead one, so it stays the silence adapter's to judge.
 *
 * The monitor is pure (probe + clock injected); the composition root binds the probe to the page.
 * An unanswered probe (page busy, evaluate timed out) is no evidence either way and changes nothing.
 */
import type { MediaHealthSource } from './ports.js';
import type { TimerScheduler } from './aloneness.js';

/** How long every remote track may stay gone, with participants present, before the bot rejoins.
 *  Long enough for the platform's own ICE restart to re-create tracks (the capture and recording
 *  rescans re-attach those by themselves), short enough that a cut-off bot misses well under a
 *  minute of a live meeting. */
export const DEFAULT_MEDIA_LOSS_GRACE_MS = 25_000;
export const DEFAULT_MEDIA_PROBE_MS = 2_000;

/** One page reading. */
export interface MediaSample {
  /** Media elements whose stream still carries a LIVE (not ended) audio track. */
  liveAudioTracks: number;
  /** Remote participants the platform still renders in the call (the bot itself excluded). */
  remoteParticipants: number;
}

/** Reads the page. Resolves `null` when it cannot tell (never throws on purpose; a throw is null). */
export type MediaProbe = () => Promise<MediaSample | null>;

export function createMediaLossMonitor(options: {
  probe: MediaProbe;
  graceMs?: number;
  pollMs?: number;
  now?: () => number;
  setInterval?: TimerScheduler['setInterval'];
  clearInterval?: TimerScheduler['clearInterval'];
  log?: (message: string) => void;
}): MediaHealthSource {
  const graceMs = options.graceMs ?? DEFAULT_MEDIA_LOSS_GRACE_MS;
  const pollMs = options.pollMs ?? DEFAULT_MEDIA_PROBE_MS;
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const log = options.log ?? ((message) => console.log(`[bot] ${message}`));

  return {
    onMediaLost(callback, subscription = {}): () => void {
      // Unarmed until live remote audio has been seen once: a page that never rendered remote
      // audio at all is not evidence of a loss, and must not send the bot into a rejoin loop.
      let armed = subscription.armed ?? false;
      let lostSince: number | null = null;
      let probing = false;
      let stopped = false;
      let fired = false;
      let handle: unknown;

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (handle !== undefined) clearIntervalFn(handle);
      };
      const tick = async (): Promise<void> => {
        if (stopped || fired || probing) return;
        probing = true;
        let sample: MediaSample | null;
        try { sample = await options.probe(); } catch { sample = null; } finally { probing = false; }
        if (stopped || fired || !sample) return;
        const at = now();
        if (sample.liveAudioTracks > 0) {
          if (lostSince !== null) log(`media: remote audio is back after ${at - lostSince}ms; no rejoin needed`);
          armed = true;
          lostSince = null;
          return;
        }
        if (!armed) return;
        if (sample.remoteParticipants <= 0) {
          // The room emptied (or the bot is no longer in the call): aloneness and removal own that.
          if (lostSince !== null) log('media: remote audio gone and no participants remain; leaving it to aloneness');
          lostSince = null;
          return;
        }
        if (lostSince === null) {
          lostSince = at;
          log(`media: every remote audio track ended with ${sample.remoteParticipants} participant(s) present;`
            + ` waiting ${graceMs}ms for them to come back`);
          return;
        }
        if (at - lostSince < graceMs) return;
        fired = true;
        stop();
        log(`media: remote audio lost for ${at - lostSince}ms with ${sample.remoteParticipants} participant(s) present`);
        callback();
      };

      handle = setIntervalFn(() => { void tick(); }, pollMs);
      void tick();
      return stop;
    },
  };
}
