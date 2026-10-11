/**
 * TC-903 — a bot cut off from a live meeting rejoins instead of leaving on silence.
 *
 * Three levels, all offline:
 *   1. the media-loss monitor (pure; fake clock + scheduler);
 *   2. the Google Meet page probe (the real serialized callback over a fake DOM);
 *   3. the orchestrator with the REAL silence aloneness + activity tap + loss monitor on one clock,
 *      replaying the meeting-95 timeline (audio, then every remote track ends with participants
 *      still present). Without the monitor that timeline ends completed(left_alone); with it the bot
 *      rejoins and the silence window never fires. Genuine silence and an emptied room keep their
 *      existing left_alone exits.
 * Run: npx tsx src/media-recovery.test.ts
 */
import { createMediaLossMonitor, DEFAULT_MEDIA_LOSS_GRACE_MS, type MediaSample } from './media-recovery.js';
import { createRemoteAudioActivityTap, createSilenceAlonenessSource } from './aloneness.js';
import { probeMeetRemoteMedia } from './capture-bridge.js';
import { createOrchestrator, MAX_MEDIA_REJOINS, type MeetingResult } from './orchestrator.js';
import { canTransition, type Act, type LifecycleEvent } from './contracts.js';
import type { JoinDriver, JoinOutcome, LifecycleSink, MediaHealthSource, Pipeline } from './ports.js';
import type { Invocation } from './config.js';
import { noopActs, noopAloneness } from './test-doubles.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

class FakeClock {
  nowMs = 0;
  now = (): number => this.nowMs;
  advance(ms: number): void { this.nowMs += ms; }
}

class FakeScheduler {
  private callbacks = new Map<number, () => void>();
  private nextId = 1;
  readonly setInterval = (callback: () => void, _ms: number): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };
  readonly clearInterval = (id: unknown): void => { this.callbacks.delete(id as number); };
  tick(): void { for (const callback of [...this.callbacks.values()]) callback(); }
  get activeCount(): number { return this.callbacks.size; }
}

/** Let async probes, the orchestrator's awaits and fake drivers run to quiescence. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const LIVE: MediaSample = { liveAudioTracks: 3, remoteParticipants: 2 };
const LOST: MediaSample = { liveAudioTracks: 0, remoteParticipants: 2 };
const EMPTY: MediaSample = { liveAudioTracks: 0, remoteParticipants: 0 };

function monitorFixture(initial: MediaSample | null, graceMs = 10_000) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  let sample: MediaSample | null = initial;
  let probeThrows = false;
  const logs: string[] = [];
  const monitor = createMediaLossMonitor({
    probe: async () => { if (probeThrows) throw new Error('page gone'); return sample; },
    graceMs, pollMs: 1_000, now: clock.now,
    setInterval: scheduler.setInterval, clearInterval: scheduler.clearInterval,
    log: (m) => logs.push(m),
  });
  let fired = 0;
  const step = async (ms: number): Promise<void> => { clock.advance(ms); scheduler.tick(); await settle(); };
  return {
    clock, scheduler, logs, monitor, step,
    get fired() { return fired; },
    onLost: () => { fired++; },
    set: (next: MediaSample | null) => { sample = next; },
    setThrows: (v: boolean) => { probeThrows = v; },
  };
}

async function monitorTests(): Promise<void> {
  console.log('media-loss monitor');
  {
    const f = monitorFixture(LIVE);
    const stop = f.monitor.onMediaLost(f.onLost);
    await f.step(1_000);
    f.set(LOST);
    await f.step(1_000);                       // loss observed
    await f.step(9_000);                       // 9s into a 10s grace
    check('tracks ended with participants: no verdict inside the grace window', f.fired === 0);
    await f.step(1_000);
    check('tracks ended with participants: fires once the grace window elapses', f.fired === 1);
    await f.step(30_000);
    check('fires at most once per subscription', f.fired === 1 && f.scheduler.activeCount === 0);
    check('the loss is logged with the participant count', f.logs.some((l) => /every remote audio track ended with 2 participant/.test(l)));
    stop();
  }
  {
    const f = monitorFixture(LIVE);
    f.monitor.onMediaLost(f.onLost);
    await f.step(1_000);
    f.set(LOST);
    await f.step(1_000);
    await f.step(5_000);
    f.set({ liveAudioTracks: 2, remoteParticipants: 2 });   // Meet re-created the tracks (ICE restart)
    await f.step(1_000);
    f.set(LOST);
    await f.step(1_000);
    await f.step(9_000);
    check('tracks that come back inside the grace window reset it (no rejoin)', f.fired === 0);
    check('the recovery is logged', f.logs.some((l) => /remote audio is back/.test(l)));
  }
  {
    const f = monitorFixture(LIVE);
    f.monitor.onMediaLost(f.onLost);
    await f.step(1_000);
    f.set(EMPTY);
    for (let i = 0; i < 30; i++) await f.step(1_000);
    check('everyone left (no participants): never a media-loss verdict', f.fired === 0);
  }
  {
    const f = monitorFixture(LOST);
    f.monitor.onMediaLost(f.onLost);
    for (let i = 0; i < 30; i++) await f.step(1_000);
    check('unarmed: a page that never had live remote audio is not a loss', f.fired === 0);
    const g = monitorFixture(LOST);
    g.monitor.onMediaLost(g.onLost, { armed: true });
    for (let i = 0; i < 12; i++) await g.step(1_000);
    check('armed (post-rejoin): no live audio at all with participants present is a loss', g.fired === 1);
  }
  {
    const f = monitorFixture(LIVE);
    f.monitor.onMediaLost(f.onLost);
    await f.step(1_000);
    f.set(LOST);
    await f.step(1_000);
    f.set(null);                               // page busy / probe timed out
    await f.step(5_000);
    f.setThrows(true);
    await f.step(1_000);
    check('an unanswered or throwing probe is no evidence (no verdict)', f.fired === 0);
    f.setThrows(false);
    f.set(LOST);
    await f.step(4_000);
    check('…and does not reset a loss already being timed', f.fired === 1);
  }
  {
    const f = monitorFixture(LIVE);
    const stop = f.monitor.onMediaLost(f.onLost);
    await f.step(1_000);
    f.set(LOST);
    await f.step(1_000);
    stop();
    await f.step(20_000);
    check('stop() cancels a pending verdict', f.fired === 0 && f.scheduler.activeCount === 0);
  }
  check('default grace is bounded under 30s', DEFAULT_MEDIA_LOSS_GRACE_MS >= 20_000 && DEFAULT_MEDIA_LOSS_GRACE_MS <= 30_000);
}

// ── Google Meet page probe: the real serialized callback against a fake DOM ──
type FakeEl = Record<string, any>;
const mediaEl = (states: string[]): FakeEl => ({ srcObject: { getAudioTracks: () => states.map((readyState) => ({ readyState })) } });
const tile = (id: string, self = false): FakeEl => ({
  getAttribute: (name: string) => (name === 'data-participant-id' ? id : null),
  hasAttribute: (name: string) => self && name === 'data-self-name',
  querySelector: () => null,
  closest: () => null,
});

async function probeTests(): Promise<void> {
  console.log('google meet media probe');
  const g = globalThis as Record<string, any>;
  const original = g.document;
  const runOn = (media: FakeEl[], tiles: FakeEl[], selfMarker: FakeEl | null) => {
    g.document = {
      querySelectorAll: (sel: string) => (sel === 'audio, video' ? media : sel === '[data-participant-id]' ? tiles : []),
      querySelector: (sel: string) => (sel === '[data-self-name]' ? selfMarker : null),
    };
  };
  const page = { evaluate: async (fn: () => unknown) => fn() };
  try {
    const selfTile = tile('self-id', true);
    runOn([mediaEl(['live']), mediaEl(['ended']), mediaEl(['live', 'ended']), { srcObject: null }],
      [tile('a'), tile('b'), tile('b'), selfTile], { closest: () => selfTile });
    const live = await probeMeetRemoteMedia(page as any);
    check('probe: counts media elements holding a live audio track', live?.liveAudioTracks === 2, JSON.stringify(live));
    check('probe: counts distinct remote tiles, self excluded', live?.remoteParticipants === 2, JSON.stringify(live));

    runOn([mediaEl(['ended']), mediaEl(['ended']), mediaEl(['ended'])], [tile('a'), tile('b'), tile('c')], null);
    const unmarked = await probeMeetRemoteMedia(page as any);
    check('probe: tracks ended → zero live tracks (the incident reading)', unmarked?.liveAudioTracks === 0);
    check('probe: no identifiable self tile → one tile assumed to be the bot (only under-counts)', unmarked?.remoteParticipants === 2);

    runOn([], [tile('self-only')], null);
    check('probe: the bot alone with an unmarked tile reads zero participants',
      (await probeMeetRemoteMedia(page as any))?.remoteParticipants === 0);

    const hung = { evaluate: () => new Promise(() => { /* page stalled */ }) };
    check('probe: a stalled page resolves null (no evidence)', (await probeMeetRemoteMedia(hung as any, 10)) === null);
    const closed = { evaluate: async () => { throw new Error('Target closed'); } };
    check('probe: a closed page resolves null', (await probeMeetRemoteMedia(closed as any)) === null);
  } finally {
    g.document = original;
  }
}

// ── orchestrator ──
const inv = (): Invocation => ({
  platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'B',
  redisUrl: 'redis://r:6379', connectionId: 'sess-uid', nativeMeetingId: 'abc-defg-hij',
});
const lifecycle = (): LifecycleSink & { events: LifecycleEvent[] } => {
  const events: LifecycleEvent[] = [];
  return { events, async emit(e) { events.push(e); } };
};
const legal = (events: LifecycleEvent[]): boolean =>
  events.every((e, i) => i === 0 || e.status === events[i - 1].status || canTransition(events[i - 1].status, e.status));
const RUN = { pipelineStopMs: 50, recordingDrainMs: 50, platformLeaveMs: 50, rejoinCancelMs: 50 };

interface DriverLog { joins: number; leaves: string[]; withdraws: string[]; removalSubs: number; removalStops: number }
/** A join driver whose FIRST join admits (with lobby reports) and whose later joins (rejoins)
 *  resolve to `rejoin(n, signal)` — a verdict, or a promise the test controls. */
function driver(rejoin: (n: number, signal?: AbortSignal) => JoinOutcome | Promise<JoinOutcome> = () => 'admitted') {
  const log: DriverLog = { joins: 0, leaves: [], withdraws: [], removalSubs: 0, removalStops: 0 };
  const join: JoinDriver = {
    async join(report, options) {
      log.joins++;
      if (log.joins === 1) { await report('awaiting_admission'); await report('active'); return 'admitted'; }
      return rejoin(log.joins - 1, options?.signal);
    },
    onRemoval() { log.removalSubs++; return () => { log.removalStops++; }; },
    async leave(reason) { log.leaves.push(reason); },
    async withdraw(reason) { log.withdraws.push(reason); },
  };
  return { join, log };
}

/** Real silence aloneness + activity tap + loss monitor on one fake clock — the production wiring. */
function liveFixture(withMonitor: boolean, windowMs = 300_000) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const activity = createRemoteAudioActivityTap({ now: clock.now });
  const logs: string[] = [];
  const aloneness = createSilenceAlonenessSource({
    activity, windowMs, now: clock.now, pollMs: 1_500,
    setInterval: scheduler.setInterval, clearInterval: scheduler.clearInterval, log: (m) => logs.push(m),
  });
  let page: MediaSample = LIVE;
  const mediaHealth = withMonitor ? createMediaLossMonitor({
    probe: async () => page, now: clock.now,
    setInterval: scheduler.setInterval, clearInterval: scheduler.clearInterval, log: (m) => logs.push(m),
  }) : undefined;
  let resumed = 0;
  // The page signals ready once capture attaches; a resumed capture does the same.
  const pipeline: Pipeline = {
    async start() { activity.ready(); },
    async stop() { /* */ },
    async resumeAfterRejoin() { resumed++; activity.ready(); },
  };
  const step = async (ms: number): Promise<void> => { clock.advance(ms); scheduler.tick(); await settle(); };
  const advance = async (totalMs: number, stepMs = 2_000): Promise<void> => {
    for (let t = 0; t < totalMs; t += stepMs) await step(stepMs);
  };
  return {
    clock, activity, aloneness, mediaHealth, pipeline, logs, step, advance,
    get resumed() { return resumed; },
    setPage: (next: MediaSample) => { page = next; },
  };
}

async function orchestratorTests(): Promise<void> {
  console.log('orchestrator: meeting-95 timeline');
  // Red: today's wiring (no monitor). Audio until t=60s, then every remote track ends with the
  // participants still in the call. The silence window (300s) expires and the bot leaves.
  {
    const fx = liveFixture(false);
    const lc = lifecycle();
    const { join, log } = driver();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: fx.pipeline, acts: noopActs(), aloneness: fx.aloneness });
    const running = o.run(RUN);
    await settle();
    fx.activity.observeRemoteEnergy(0.02);
    await fx.advance(60_000);
    fx.setPage(LOST);
    await fx.advance(260_000);
    const res = await Promise.race([running, new Promise<null>((r) => setTimeout(() => r(null), 500))]);
    check('control (no monitor): the deaf bot leaves a live meeting as completed(left_alone)',
      res?.completionReason === 'left_alone' && log.joins === 1, JSON.stringify(res));
  }
  // Green: same timeline with the monitor. ~25s after the tracks end the bot leaves and rejoins,
  // capture resumes, and the 300s mark passes with no silence verdict.
  {
    const fx = liveFixture(true);
    const lc = lifecycle();
    const { join, log } = driver();
    let fire: (a: Act) => void = () => {};
    const o = createOrchestrator(inv(), {
      lifecycle: lc, join, pipeline: fx.pipeline, acts: noopActs((f) => { fire = f; }), aloneness: fx.aloneness, mediaHealth: fx.mediaHealth,
    });
    let result: MeetingResult | undefined;
    const running = o.run(RUN).then((r) => { result = r; return r; });
    await settle();
    fx.activity.observeRemoteEnergy(0.02);
    await fx.advance(60_000);
    fx.setPage(LOST);
    await fx.advance(20_000);
    check('tracks ended, participants present: no rejoin inside the grace window', log.joins === 1 && log.leaves.length === 0);
    await fx.advance(10_000);
    check('tracks ended, participants present: recovery attempted (leave media_lost → rejoin)',
      log.joins === 2 && log.leaves.join(',') === 'media_lost', JSON.stringify(log));
    check('…capture resumed on the rejoined page', fx.resumed === 1);
    check('…removal monitor paused for the deliberate leave and re-armed after', log.removalStops >= 1 && log.removalSubs === 2, JSON.stringify(log));
    fx.setPage(LIVE);
    await fx.advance(240_000);                 // past the original t=300s silence deadline
    check('not a silence exit: still active past the old silence deadline', result === undefined && lc.events.at(-1)?.status === 'active');
    check('lifecycle never left active during the rejoin', lc.events.filter((e) => e.status === 'active').length === 1);
    fire({ action: 'leave' });
    const res = await running;
    check('the run ends on its real end signal: completed(stopped)', res.status === 'completed' && res.completionReason === 'stopped');
    check('lifecycle sequence legal', legal(lc.events), lc.events.map((e) => e.status).join('>'));
  }

  console.log('orchestrator: existing exits unchanged');
  // Genuine silence: the tracks stay live (Meet's slots carry zeros), nobody talks → left_alone.
  {
    const fx = liveFixture(true);
    const lc = lifecycle();
    const { join, log } = driver();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: fx.pipeline, acts: noopActs(), aloneness: fx.aloneness, mediaHealth: fx.mediaHealth });
    const running = o.run(RUN);
    await settle();
    fx.activity.observeRemoteEnergy(0);        // digitally silent frames: arrival, not presence
    await fx.advance(302_000);
    const res = await Promise.race([running, new Promise<null>((r) => setTimeout(() => r(null), 500))]);
    check('genuine silence (live tracks, no speech): completed(left_alone), no rejoin',
      res?.completionReason === 'left_alone' && log.joins === 1 && !log.leaves.includes('media_lost'), JSON.stringify({ res, log }));
  }
  // Everyone left: tiles gone and tracks ended → no rejoin, the silence rule still ends it.
  {
    const fx = liveFixture(true);
    const lc = lifecycle();
    const { join, log } = driver();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: fx.pipeline, acts: noopActs(), aloneness: fx.aloneness, mediaHealth: fx.mediaHealth });
    const running = o.run(RUN);
    await settle();
    fx.activity.observeRemoteEnergy(0.02);
    await fx.advance(30_000);
    fx.setPage(EMPTY);
    await fx.advance(272_000);
    const res = await Promise.race([running, new Promise<null>((r) => setTimeout(() => r(null), 500))]);
    check('everyone left: completed(left_alone), no rejoin', res?.completionReason === 'left_alone' && log.joins === 1, JSON.stringify({ res, log }));
  }
  // Host removal still wins: evicted, no rejoin.
  {
    let fireRemoval: () => void = () => {};
    const lc = lifecycle();
    const base = driver();
    const join: JoinDriver = { ...base.join, onRemoval(cb) { fireRemoval = cb; return () => {}; } };
    const media = controlledMedia();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs(), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run(RUN);
    await settle();
    fireRemoval();
    const res = await running;
    media.fire();                              // a late loss verdict after the run ended
    await settle();
    check('host removal: completed(evicted), no rejoin', res.completionReason === 'evicted' && base.log.joins === 1);
  }

  console.log('orchestrator: rejoin outcomes');
  // Rejoin not admitted (lobby timeout / denial / error) → failed at active, labelled like a first
  // join's verdict and attributed to the rejoin by its reason code.
  const REJOIN_COMPLETION = { timeout: 'awaiting_admission_timeout', rejected: 'awaiting_admission_rejected', error: 'join_failure' } as const;
  for (const outcome of ['timeout', 'rejected', 'error'] as const) {
    const lc = lifecycle();
    const { join, log } = driver(() => outcome);
    const media = controlledMedia();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs(), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run(RUN);
    await settle();
    media.fire();
    const res = await running;
    const terminal = lc.events.at(-1)!;
    check(`rejoin ${outcome}: failed(${REJOIN_COMPLETION[outcome]}) at stage active, exit 1`,
      res.status === 'failed' && res.exitCode === 1 && terminal.failure_stage === 'active'
        && terminal.completion_reason === REJOIN_COMPLETION[outcome] && res.completionReason === REJOIN_COMPLETION[outcome],
      String(terminal.completion_reason));
    check(`rejoin ${outcome}: reason names the rejoin`, terminal.reason === `capture failed (stage=active code=rejoin_${outcome})`, String(terminal.reason));
    check(`rejoin ${outcome}: exactly one terminal, legal sequence`,
      lc.events.filter((e) => e.status === 'failed' || e.status === 'completed').length === 1 && legal(lc.events));
    check(`rejoin ${outcome}: left the call, then withdrew (off the call at teardown)`,
      log.leaves.join(',') === 'media_lost' && log.withdraws.length === 1, JSON.stringify(log));
  }
  console.log('orchestrator: end signals during a rejoin');
  /** A rejoin parked in the lobby until its signal aborts; records when it settled. */
  const lobbyRejoin = (order: string[], seen: { signal?: AbortSignal }) => (_n: number, signal?: AbortSignal) =>
    new Promise<JoinOutcome>((_resolve, reject) => {
      seen.signal = signal;
      signal?.addEventListener('abort', () => { order.push('join-settled'); reject(signal.reason); });
    });
  // 1. A user stop cancels the rejoin, waits for it to stop, then stops the pipeline and withdraws.
  {
    const lc = lifecycle();
    const order: string[] = [];
    const seen: { signal?: AbortSignal } = {};
    const { join, log } = driver(lobbyRejoin(order, seen));
    const media = controlledMedia();
    let fire: (a: Act) => void = () => {};
    const o = createOrchestrator(inv(), {
      lifecycle: lc, join, pipeline: { async start() {}, async stop() { order.push('pipeline-stop'); } },
      acts: noopActs((f) => { fire = f; }), aloneness: noopAloneness(), mediaHealth: media.source,
    });
    const running = o.run(RUN);
    await settle();
    media.fire();
    await settle();
    fire({ action: 'leave' });
    const res = await running;
    check('stop during a pending rejoin: completed(stopped)', res.status === 'completed' && res.completionReason === 'stopped' && log.joins === 2);
    check('…the rejoin was cancelled', seen.signal?.aborted === true);
    check('…and settled before the pipeline stopped', order.join(',') === 'join-settled,pipeline-stop', order.join(','));
    check('…the bot withdrew instead of leaving again', log.leaves.join(',') === 'media_lost' && log.withdraws.join(',') === 'stopped', JSON.stringify(log));
  }
  // 2. The pipeline stop must not run against a page the rejoin is still navigating.
  {
    const lc = lifecycle();
    let navigating = false;
    const { join } = driver((_n, signal) => new Promise<JoinOutcome>((_resolve, reject) => {
      navigating = true;
      signal?.addEventListener('abort', () => setImmediate(() => { navigating = false; reject(signal.reason); }));
    }));
    const media = controlledMedia();
    let fire: (a: Act) => void = () => {};
    const o = createOrchestrator(inv(), {
      lifecycle: lc, join,
      pipeline: { async start() {}, async stop() { if (navigating) throw new Error('Execution context was destroyed'); } },
      acts: noopActs((f) => { fire = f; }), aloneness: noopAloneness(), mediaHealth: media.source,
    });
    const running = o.run(RUN);
    await settle();
    media.fire();
    await settle();
    fire({ action: 'leave' });
    const res = await running;
    check('stop mid-navigation: the pipeline stops on a settled page (completed, not a teardown failure)',
      res.status === 'completed' && res.completionReason === 'stopped', JSON.stringify(res));
  }
  // 3. SIGTERM during a rejoin.
  {
    const lc = lifecycle();
    const seen: { signal?: AbortSignal } = {};
    const { join, log } = driver(lobbyRejoin([], seen));
    const media = controlledMedia();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs(), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run(RUN);
    await settle();
    media.fire();
    await settle();
    o.stop('stopped', true);
    const res = await running;
    check('SIGTERM during a rejoin: completed(stopped), one withdraw', res.completionReason === 'stopped' && seen.signal?.aborted === true && log.withdraws.length === 1, JSON.stringify(log));
  }
  // 4. The max-active cap during a rejoin.
  {
    const lc = lifecycle();
    const seen: { signal?: AbortSignal } = {};
    const { join, log } = driver(lobbyRejoin([], seen));
    const media = controlledMedia();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs(), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run({ ...RUN, maxActiveMs: 30 });
    await settle();
    media.fire();
    const res = await running;
    check('time cap during a rejoin: max_bot_time_exceeded, rejoin cancelled, one withdraw',
      res.completionReason === 'max_bot_time_exceeded' && seen.signal?.aborted === true && log.withdraws.length === 1, JSON.stringify({ res, log }));
  }
  // 5. A join that ignores the signal cannot hold teardown hostage.
  {
    const lc = lifecycle();
    const { join, log } = driver(() => new Promise<JoinOutcome>(() => { /* ignores the abort */ }));
    const media = controlledMedia();
    let fire: (a: Act) => void = () => {};
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs((f) => { fire = f; }), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run(RUN);
    await settle();
    media.fire();
    await settle();
    const started = Date.now();
    fire({ action: 'leave' });
    const res = await Promise.race([running, new Promise<null>((r) => setTimeout(() => r(null), 1_000))]);
    check('a rejoin that ignores the abort: teardown is bounded, completed(stopped), one withdraw',
      res?.completionReason === 'stopped' && Date.now() - started < 1_000 && log.withdraws.length === 1, JSON.stringify({ res, log }));
  }

  console.log('orchestrator: no rejoin that cannot pay off');
  // L5: capture cannot resume after a rejoin → no rejoin; the bot stays seated, monitors untouched.
  {
    const lc = lifecycle();
    const { join, log } = driver();
    const media = controlledMedia();
    let fire: (a: Act) => void = () => {};
    const o = createOrchestrator(inv(), {
      lifecycle: lc, join, pipeline: { async start() {}, async stop() {}, canResumeAfterRejoin: () => false },
      acts: noopActs((f) => { fire = f; }), aloneness: noopAloneness(), mediaHealth: media.source,
    });
    const running = o.run(RUN);
    await settle();
    media.fire();
    await settle();
    check('capture cannot resume: no leave, no rejoin, removal untouched',
      log.joins === 1 && log.leaves.length === 0 && log.removalStops === 0 && lc.events.at(-1)?.status === 'active', JSON.stringify(log));
    fire({ action: 'leave' });
    const res = await running;
    check('…and the run still ends on its real end signal', res.completionReason === 'stopped');
  }
  // L6: a browser crash that surfaces as a rejected rejoin ends the run as the browser failure.
  {
    const lc = lifecycle();
    let crash: (f: 'browser_crashed' | 'browser_closed') => void = () => {};
    const base = driver(() => {
      setTimeout(() => crash('browser_crashed'), 0);
      return Promise.reject(new Error('Target crashed'));
    });
    const join: JoinDriver = { ...base.join, onFailure(cb) { crash = cb; return () => {}; } };
    const media = controlledMedia();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs(), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run(RUN);
    await settle();
    media.fire();
    const res = await running;
    const terminal = lc.events.at(-1)!;
    check('browser crash during a rejoin: failed as browser_crashed, no completion reason',
      res.status === 'failed' && String(terminal.reason).startsWith('browser_crashed:') && terminal.completion_reason === undefined,
      JSON.stringify(terminal));
  }
  // Bounded: after MAX_MEDIA_REJOINS the bot stays seated and stops rejoining.
  {
    const lc = lifecycle();
    const { join, log } = driver();
    const media = controlledMedia();
    let resumed = 0;
    let fire: (a: Act) => void = () => {};
    const o = createOrchestrator(inv(), {
      lifecycle: lc, join, pipeline: { async start() {}, async stop() {}, async resumeAfterRejoin() { resumed++; } },
      acts: noopActs((f) => { fire = f; }), aloneness: noopAloneness(), mediaHealth: media.source,
    });
    const running = o.run(RUN);
    await settle();
    for (let i = 0; i < MAX_MEDIA_REJOINS + 2; i++) { media.fire(); await settle(); }
    check(`rejoins are bounded at ${MAX_MEDIA_REJOINS}`, log.joins === 1 + MAX_MEDIA_REJOINS && resumed === MAX_MEDIA_REJOINS, JSON.stringify(log));
    check('the first watch is unarmed; post-rejoin watches are armed', media.armed.join(',') === ['false', ...Array(MAX_MEDIA_REJOINS).fill('true')].join(','), media.armed.join(','));
    fire({ action: 'leave' });
    const res = await running;
    check('…and still ends on its real end signal', res.completionReason === 'stopped');
  }
}

/** A media-health double the test fires by hand; records each subscription's `armed`. */
function controlledMedia() {
  let callback: (() => void) | null = null;
  const armed: boolean[] = [];
  const source: MediaHealthSource = {
    onMediaLost(cb, options) {
      armed.push(options?.armed ?? false);
      callback = cb;
      return () => { callback = null; };
    },
  };
  return { source, armed, fire: () => { const cb = callback; callback = null; cb?.(); } };
}

await monitorTests();
await probeTests();
await orchestratorTests();
if (failed > 0) {
  console.error(`\n❌ media recovery: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\n✅ media recovery: tracks lost with participants present → rejoin; silence / empty room / removal unchanged');
