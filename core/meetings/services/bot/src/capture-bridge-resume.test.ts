/**
 * TC-903 — after a rejoin re-navigates the Google Meet page, the capture bridge re-attaches the
 * page side on the new document while every Node-side owner keeps running. Drives the real
 * serialized page callbacks through a fake page (evaluate runs in this realm; a "navigation" wipes
 * the page globals exactly as a new document would, while exposed bindings survive as Playwright's
 * do). Also pins createLivePipeline's resume contract.
 * Run: npx tsx src/capture-bridge-resume.test.ts
 */
import { startCaptureBridge } from './capture-bridge.js';
import { createLivePipeline, type CaptureHandle } from './pipeline.js';
import { createRemoteAudioActivityTap } from './aloneness.js';
import type { BotPipeline } from './pipeline.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const g = globalThis as Record<string, any>;
const PAGE_GLOBALS = ['VexaBrowserUtils', '__vexaGmeetCapture', '__vexaGmeetSpeakers', '__vexaFeedWarned'];
const BINDINGS = ['__vexaPerSpeakerAudioData', '__vexaNamedAudioData', '__vexaAttributedBoundaryOverflow', '__vexaSpeakerHint',
  '__vexaTeamsCaption', '__vexaCsrc', '__vexaObservation', '__vexaRemoteAudioReady', '__vexaStreamPresence', '__vexaChatMessage'];
const saved = Object.fromEntries([...PAGE_GLOBALS, ...BINDINGS].map((k) => [k, g[k]]));

/** One fake gmeet capture per document; `emit(i)` delivers PCM on page-local stream index i. */
const captures: Array<{ emit: (index: number) => void; started: boolean }> = [];
const installUtils = (): void => {
  g.VexaBrowserUtils = {
    createGmeetCapture: (opts: { onAudio: (index: number, pcm: Float32Array) => void }) => {
      const c = { started: false, emit: (index: number) => opts.onAudio(index, new Float32Array([0.2, -0.2])) };
      captures.push(c);
      return { async start() { c.started = true; }, stop() {}, streamCount: () => 0,
        resourceCounts: () => ({ contexts: 0, sources: 0, worklets: 0, tracks: 0, references: 0 }) };
    },
  };
};
/** What a new document looks like: page globals gone, the init-script bundle re-injected. */
const navigate = (): void => {
  for (const k of PAGE_GLOBALS) delete g[k];
  installUtils();
};

const page = {
  async exposeFunction(name: string, fn: (...args: any[]) => unknown) { g[name] = fn; },
  async evaluate(callback: (...args: any[]) => unknown, ...args: any[]) { return await callback(...args); },
};
const fed: number[] = [];
const pipeline: BotPipeline = {
  async start() {}, async stop() {}, feedAudio(channel: number) { fed.push(channel); }, feedMixedAudio() {}, recordHint() {},
};
const meet: Invocation = {
  platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Vexa',
  redisUrl: 'redis://localhost:6379', transcribeEnabled: false, connectionId: 'resume-test',
};

try {
  console.log('capture bridge: resume after rejoin (google meet)');
  installUtils();
  let now = 1_000;
  const activity = createRemoteAudioActivityTap({ now: () => now });
  const handle: CaptureHandle = await startCaptureBridge(page as any, meet, pipeline, undefined, undefined, activity);
  check('google meet capture exposes resumeAfterRejoin', typeof handle.resumeAfterRejoin === 'function');
  captures[0].emit(0); captures[0].emit(2); captures[0].emit(1);
  await settle();
  check('first page: channels are the page stream indices', fed.join(',') === '0,2,1', fed.join(','));

  now = 50_000;
  navigate();                                  // the rejoin's page.goto
  await handle.resumeAfterRejoin!();
  check('resume starts a fresh page-side capture on the new document', captures.length === 2 && captures[1].started);
  check('resume restarts the silence window at the rejoin', activity.snapshot().lastRemoteAudioAt === 50_000);
  fed.length = 0;
  captures[1].emit(0); captures[1].emit(1);
  await settle();
  check('rejoined page: channels continue above every pre-rejoin channel', fed.join(',') === '3,4', fed.join(','));

  navigate();
  await handle.resumeAfterRejoin!();
  fed.length = 0;
  captures[2].emit(0);
  await settle();
  check('a second rejoin continues above the first', fed.join(',') === '5', fed.join(','));
  await handle();

  console.log('capture bridge: mixed lanes do not offer a page resume');
  for (const k of PAGE_GLOBALS) delete g[k];
  g.VexaBrowserUtils = {};
  const teams = await startCaptureBridge(page as any, { ...meet, platform: 'teams' }, { ...pipeline, hintCounters: undefined } as BotPipeline);
  check('teams capture has no resumeAfterRejoin', teams.resumeAfterRejoin === undefined);
  await teams();

  console.log('live pipeline: resume contract');
  {
    let resumed = 0;
    let stopped = 0;
    const faults: string[] = [];
    const handle = Object.assign(async () => { stopped++; }, { async resumeAfterRejoin() { resumed++; } });
    const live = createLivePipeline({
      startCapture: async () => handle, engine: { async start() {}, async stop() {} },
      onFault: (stage) => faults.push(stage),
    });
    await live.start();
    await live.resumeAfterRejoin!();
    check('resumeAfterRejoin re-runs the capture handle resume', resumed === 1 && faults.length === 0);
    await live.stop();
    await live.resumeAfterRejoin!();
    check('no resume after stop (teardown wins)', resumed === 1 && stopped === 1);
  }
  {
    const faults: string[] = [];
    const handle = Object.assign(async () => {}, { async resumeAfterRejoin() { throw new Error('page gone'); } });
    const live = createLivePipeline({
      startCapture: async () => handle, engine: { async start() {}, async stop() {} },
      onFault: (stage) => faults.push(stage),
    });
    await live.start();
    let threw = false;
    try { await live.resumeAfterRejoin!(); } catch { threw = true; }
    check('a failed resume degrades loudly (capture-start fault) and never throws', !threw && faults.join(',') === 'capture-start');
    await live.stop().catch(() => { /* not terminal without an attributed producer */ });
  }
  {
    const faults: string[] = [];
    const handle = Object.assign(async () => {}, { async resumeAfterRejoin() { throw new Error('page gone'); } });
    const live = createLivePipeline({
      startCapture: async () => handle, engine: { async start() {}, async stop() {} },
      onFault: (stage) => faults.push(stage), captureFaultTerminal: true,
    });
    await live.start();
    await live.resumeAfterRejoin!();
    let terminal = false;
    try { await live.stop(); } catch { terminal = true; }
    check('with an attributed producer, a failed resume makes the terminal truthful (stop rejects)', terminal);
  }
  {
    const faults: string[] = [];
    const live = createLivePipeline({
      startCapture: async () => async () => {}, engine: { async start() {}, async stop() {} }, onFault: (stage) => faults.push(stage),
    });
    await live.start();
    let threw = false;
    try { await live.resumeAfterRejoin!(); } catch { threw = true; }
    check('a capture without a page resume is a quiet no-op', !threw && faults.length === 0);
    await live.stop();
  }
  {
    // L4: a stop that arrives while a resume is still attaching waits for it, so capture teardown
    // never races the page-side start.
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handle = Object.assign(async () => { order.push('capture-stop'); },
      { async resumeAfterRejoin() { await gate; order.push('resume-done'); } });
    const live = createLivePipeline({ startCapture: async () => handle, engine: { async start() {}, async stop() {} }, onFault: () => {} });
    await live.start();
    const resuming = live.resumeAfterRejoin!();
    const stopping = live.stop();
    await settle();
    check('stop during an in-flight resume does not tear capture down yet', order.length === 0, order.join(','));
    release();
    await Promise.all([resuming, stopping]);
    check('…it tears down after the resume settles', order.join(',') === 'resume-done,capture-stop', order.join(','));
  }
  {
    // L5: whether a rejoin could resume capture at all.
    const failing = createLivePipeline({
      startCapture: async () => { throw new Error('page-side start failed'); },
      engine: { async start() {}, async stop() {} }, onFault: () => {},
    });
    await failing.start();
    check('capture that never started cannot resume after a rejoin', failing.canResumeAfterRejoin!() === false);
    await failing.stop();
    const handle = Object.assign(async () => {}, { async resumeAfterRejoin() {} });
    const resumable = createLivePipeline({ startCapture: async () => handle, engine: { async start() {}, async stop() {} }, onFault: () => {} });
    await resumable.start();
    check('a capture with a page resume can resume', resumable.canResumeAfterRejoin!() === true);
    await resumable.stop();
    check('…and cannot after stop', resumable.canResumeAfterRejoin!() === false);
  }
} finally {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
}

if (failed > 0) {
  console.error(`\n❌ capture-bridge resume: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\n✅ capture-bridge resume: the rejoined page re-attaches capture on fresh channels');
