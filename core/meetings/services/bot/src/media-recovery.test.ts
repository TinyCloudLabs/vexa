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
const RUN = { pipelineStopMs: 50, recordingDrainMs: 50, platformLeaveMs: 50 };

interface DriverLog { joins: number; leaves: string[]; removalSubs: number; removalStops: number }
/** A join driver whose FIRST join admits (with lobby reports) and whose later joins (rejoins)
 *  resolve to `rejoin(n)` — a verdict, or a promise the test controls. */
function driver(rejoin: (n: number) => JoinOutcome | Promise<JoinOutcome> = () => 'admitted') {
  const log: DriverLog = { joins: 0, leaves: [], removalSubs: 0, removalStops: 0 };
  const join: JoinDriver = {
    async join(report) {
      log.joins++;
      if (log.joins === 1) { await report('awaiting_admission'); await report('active'); return 'admitted'; }
      return rejoin(log.joins - 1);
    },
    onRemoval() { log.removalSubs++; return () => { log.removalStops++; }; },
    async leave(reason) { log.leaves.push(reason); },
    async withdraw() { /* */ },
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
  // Rejoin not admitted (lobby timeout / denial) → failed at active, attributed to the rejoin.
  for (const outcome of ['timeout', 'rejected'] as const) {
    const lc = lifecycle();
    const { join, log } = driver(() => outcome);
    const media = controlledMedia();
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs(), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run(RUN);
    await settle();
    media.fire();
    const res = await running;
    const terminal = lc.events.at(-1)!;
    check(`rejoin ${outcome}: failed(join_failure) at stage active, exit 1`,
      res.status === 'failed' && res.exitCode === 1 && terminal.failure_stage === 'active' && terminal.completion_reason === 'join_failure');
    check(`rejoin ${outcome}: reason names the rejoin`, terminal.reason === `capture failed (stage=active code=rejoin_${outcome})`, String(terminal.reason));
    check(`rejoin ${outcome}: exactly one terminal, legal sequence`,
      lc.events.filter((e) => e.status === 'failed' || e.status === 'completed').length === 1 && legal(lc.events));
    check(`rejoin ${outcome}: left the call before and after`, log.leaves[0] === 'media_lost' && log.leaves.length === 2);
  }
  // A stop while the rejoin waits in the lobby ends the run as the user's stop, not a failure.
  {
    const lc = lifecycle();
    const { join, log } = driver(() => new Promise<JoinOutcome>(() => { /* lobby */ }));
    const media = controlledMedia();
    let fire: (a: Act) => void = () => {};
    const o = createOrchestrator(inv(), { lifecycle: lc, join, pipeline: { async start() {}, async stop() {} }, acts: noopActs((f) => { fire = f; }), aloneness: noopAloneness(), mediaHealth: media.source });
    const running = o.run(RUN);
    await settle();
    media.fire();
    await settle();
    fire({ action: 'leave' });
    const res = await running;
    check('stop during a pending rejoin: completed(stopped)', res.status === 'completed' && res.completionReason === 'stopped' && log.joins === 2);
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
