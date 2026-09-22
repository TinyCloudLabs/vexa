/**
 * L2 — createLivePipeline guard (#593 A4). The admitted→capture-start handoff had NO unit before
 * this: the composed pipeline was inline in index.ts (three bare awaits). This proves the
 * load-bearing invariant — a post-admission subsystem failure (page-side capture throw, recording
 * throw or engine/pyannote-model load rejecting) DEGRADES LOUDLY and NEVER rejects start(), so
 * the orchestrator's leave-on-pipeline-fail backstop never fires and the bot stays seated.
 *
 * RED on the pre-#593 inline pipeline (the first thrown await rejects start()); GREEN after.
 * Run: npx tsx src/live-pipeline.test.ts
 */
import { createBotPipeline, createLivePipeline, serr, type LiveStage } from './pipeline.js';
import type { Invocation } from './config.js';
import type { Pipeline, TranscriptSink } from './ports.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

// A fake engine (the BotPipeline seen as a Pipeline) with a controllable start + start/stop counters.
const fakeEngine = (startImpl?: () => Promise<void>): Pipeline & { starts: number; stops: number } => {
  const e = {
    starts: 0, stops: 0,
    async start(): Promise<void> { e.starts++; if (startImpl) await startImpl(); },
    async stop(): Promise<void> { e.stops++; },
  };
  return e;
};

type Spy = { started: number; stopped: number };
const okThunk = (spy: Spy) => async (): Promise<() => Promise<void>> => { spy.started++; return async () => { spy.stopped++; }; };
const throwThunk = (e: unknown) => async (): Promise<() => Promise<void>> => { throw e; };
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 1) capture-start throws a fabricated {isTrusted:true} DOM-like Event → start() RESOLVES; engine
  //    still starts; the fault is reported. This is the exact #593 self-evict class.
  {
    const faults: LiveStage[] = [];
    const engine = fakeEngine();
    let resolved = false;
    const live = createLivePipeline({
      startCapture: throwThunk({ isTrusted: true, type: 'error' }),   // the misdirecting event shape
      engine,
      onFault: (s) => faults.push(s),
      retry: { attempts: 1, delayMs: 0 },
    });
    await live.start().then(() => { resolved = true; });
    check('capture throw: start() RESOLVED (no self-evict)', resolved);
    check('capture throw: engine STILL started after the capture throw', engine.starts === 1);
    check('capture throw: onFault(capture-start) fired', faults.includes('capture-start'));
  }

  // 2) engine-start throws (the pyannote model-load reject) → start() RESOLVES; fault reported.
  {
    const faults: LiveStage[] = [];
    const capSpy: Spy = { started: 0, stopped: 0 };
    const engine = fakeEngine(async () => { throw new Error('from_pretrained: config.json not found'); });
    let resolved = false;
    const live = createLivePipeline({
      startCapture: okThunk(capSpy),
      engine,
      onFault: (s) => faults.push(s),
      retry: { attempts: 1, delayMs: 0 },
    });
    await live.start().then(() => { resolved = true; });
    check('engine throw: start() RESOLVED (bot stays seated)', resolved);
    check('engine throw: onFault(engine-start) fired', faults.includes('engine-start'));
    check('engine throw: capture attached first', capSpy.started === 1);
  }

  // 3) A requested recording-start throws → start() resolves for orderly cleanup, but stop()
  // reports the terminal artifact failure after releasing capture and the engine.
  {
    const faults: LiveStage[] = [];
    const capSpy: Spy = { started: 0, stopped: 0 };
    const engine = fakeEngine();
    let resolved = false;
    const live = createLivePipeline({
      startCapture: okThunk(capSpy),
      startRecording: throwThunk(new Error('MediaRecorder boom')),
      engine,
      onFault: (s) => faults.push(s),
      retry: { attempts: 1, delayMs: 0 },
    });
    await live.start().then(() => { resolved = true; });
    check('recording throw: start() RESOLVED', resolved);
    check('recording throw: onFault(recording-start) fired', faults.includes('recording-start'));
    check('recording throw: engine STILL started', engine.starts === 1);
    let rejected = false;
    try { await live.stop(); } catch { rejected = true; }
    check('recording throw: terminal outcome rejects after cleanup',
      rejected && capSpy.stopped === 1 && engine.stops === 1,
      JSON.stringify({ rejected, capSpy, engineStops: engine.stops }));
  }

  // 4) happy path → no faults; stop() tears down capture + recording + engine.
  {
    const faults: LiveStage[] = [];
    const capSpy: Spy = { started: 0, stopped: 0 };
    const recSpy: Spy = { started: 0, stopped: 0 };
    const engine = fakeEngine();
    const live = createLivePipeline({
      startCapture: okThunk(capSpy), startRecording: okThunk(recSpy), engine, onFault: (s) => faults.push(s),
    });
    await live.start();
    check('happy: no faults', faults.length === 0, faults.join(','));
    check('happy: engine started', engine.starts === 1);
    await live.stop();
    check('happy: stop tore down capture', capSpy.stopped === 1);
    check('happy: stop tore down recording', recSpy.stopped === 1);
    check('happy: stop stopped engine', engine.stops === 1);
  }

  // 5) engine retry: fails once then succeeds → self-heals in the background without evicting.
  {
    let attempts = 0;
    const engine = fakeEngine(async () => { attempts++; if (attempts === 1) throw new Error('transient model load'); });
    const live = createLivePipeline({
      startCapture: okThunk({ started: 0, stopped: 0 }), engine, onFault: () => {}, retry: { attempts: 3, delayMs: 5 },
    });
    await live.start();
    check('retry: start() resolved despite first-attempt failure', true);
    await tick(40);   // let the background retry timer fire
    check('retry: engine eventually started (self-heal)', attempts >= 2, `attempts=${attempts}`);
    await live.stop();
  }

  // 6) stop() cancels a pending retry timer — no leaked timer, no post-stop start attempts.
  {
    let attempts = 0;
    const engine = fakeEngine(async () => { attempts++; throw new Error('always fails'); });
    const live = createLivePipeline({
      startCapture: okThunk({ started: 0, stopped: 0 }), engine, onFault: () => {}, retry: { attempts: 5, delayMs: 5 },
    });
    await live.start();
    const afterStart = attempts;
    await live.stop();
    await tick(40);
    check('stop: no further engine attempts after stop (timer cancelled)', attempts === afterStart, `after=${afterStart} now=${attempts}`);
  }

  // 7) stop() while capture attach is in flight tears down the late handle and never starts the
  //    later recording/engine stages. This is the real browser-failure ordering in the orchestrator.
  {
    let captureEntered!: () => void;
    const captureStarted = new Promise<void>((resolve) => { captureEntered = resolve; });
    let finishCapture!: (stop: () => Promise<void>) => void;
    let captureStops = 0;
    let recordingStarts = 0;
    const engine = fakeEngine();
    const live = createLivePipeline({
      startCapture: async () => {
        captureEntered();
        return new Promise<() => Promise<void>>((resolve) => { finishCapture = resolve; });
      },
      startRecording: async () => {
        recordingStarts++;
        return async () => {};
      },
      engine,
      onFault: () => {},
    });
    const starting = live.start();
    await captureStarted;
    await live.stop();
    finishCapture(async () => { captureStops++; });
    await starting;
    check('stop-during-capture: late capture handle is torn down exactly once', captureStops === 1, String(captureStops));
    check('stop-during-capture: recording and engine never start after stop', recordingStarts === 0 && engine.starts === 0,
      `recording=${recordingStarts} engine=${engine.starts}`);
  }

  // 8) stop() while engine.start() is in flight re-stops the engine after its late completion.
  {
    let engineEntered!: () => void;
    const engineStarted = new Promise<void>((resolve) => { engineEntered = resolve; });
    let finishEngine!: () => void;
    const engine = fakeEngine(async () => {
      engineEntered();
      await new Promise<void>((resolve) => { finishEngine = resolve; });
    });
    const live = createLivePipeline({
      startCapture: okThunk({ started: 0, stopped: 0 }), engine, onFault: () => {},
    });
    const starting = live.start();
    await engineStarted;
    await live.stop();
    finishEngine();
    await starting;
    check('stop-during-engine: late engine completion is stopped again', engine.starts === 1 && engine.stops === 2,
      `starts=${engine.starts} stops=${engine.stops}`);
  }

  // 9) serr: full-fidelity serialization — the A1 fix for the {isTrusted:true} fidelity loss.
  {
    const e = new Error('config.json not found');
    check('serr: Error → includes message', serr(e).includes('config.json not found'));
    check('serr: Error → includes a stack frame', /\bat\b/.test(serr(e)));
    check('serr: bare object → NOT flattened to [object …]', !serr({ isTrusted: true }).includes('[object'));
  }

  // 10) A bounded attributed-audio stop failure is visible as an incomplete capture outcome but
  // does not prevent the engine from being torn down in the controlled bot exit path.
  {
    const faults: LiveStage[] = [];
    const engine = fakeEngine();
    const live = createLivePipeline({
      startCapture: async () => async () => { throw new Error('attributed close timed out'); },
      engine, captureFaultTerminal: true, onFault: (stage) => faults.push(stage),
    });
    await live.start();
    let rejected = false;
    try { await live.stop(); } catch { rejected = true; }
    check('capture-stop failure: observable incomplete capture fault', faults.includes('capture-stop'));
    check('capture-stop failure: engine still tears down', engine.stops === 1);
    check('capture-stop failure: terminal outcome remains failed after cleanup', rejected);
  }

  // 11) Disabling live STT owns only the transcription engine. Capture and the durable recording
  // tap still run, while the recording-only pipeline accepts PCM without allocating turn state or
  // emitting a false transcript final. This is the integration seam between the memory and
  // attributed-audio lanes: recording may be the sole requested artifact for a live meeting.
  {
    const invocation: Invocation = {
      platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Vexa',
      redisUrl: 'redis://localhost:6379', transcribeEnabled: false, recordingEnabled: true,
    };
    const published: unknown[] = [];
    const transcript: TranscriptSink = {
      async publish(segment) { published.push(segment); },
      async retract() { /* recording-only mode has no pending transcript tail */ },
    };
    const engine = createBotPipeline(invocation, transcript);
    const capture: Spy = { started: 0, stopped: 0 };
    const recording: Spy = { started: 0, stopped: 0 };
    const live = createLivePipeline({
      startCapture: okThunk(capture), startRecording: okThunk(recording), engine, onFault: () => {},
    });
    await live.start();
    engine.feedAudio(0, 'Alice', new Float32Array(320).fill(0.1), Date.now());
    await live.stop();
    check('recording-only: capture and durable recording start even when live STT is disabled',
      capture.started === 1 && recording.started === 1, JSON.stringify({ capture, recording }));
    check('recording-only: capture and recording both release on stop',
      capture.stopped === 1 && recording.stopped === 1, JSON.stringify({ capture, recording }));
    check('recording-only: PCM does not allocate STT state or publish a false transcript final',
      engine.resourceCounts === undefined && published.length === 0, JSON.stringify({ resources: engine.resourceCounts, published }));
  }

  // The attributed/recording-only composition is deliberately real at the failure boundary: the
  // actual disabled-STT engine stays seated while capture start, recording start, and manifest-close
  // faults are retained and turn the eventual lifecycle result into a failure.
  for (const [name, captureFailure, captureStopFailure] of [
    ['attributed capture start', true, false],
    ['attributed capture stop', false, true],
  ] as const) {
    const invocation: Invocation = {
      platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Vexa',
      redisUrl: 'redis://localhost:6379', transcribeEnabled: false, recordingEnabled: true,
      attributedAudioEnabled: true,
    };
    const engine = createBotPipeline(invocation, { async publish() {}, async retract() {} });
    const faults: LiveStage[] = [];
    const live = createLivePipeline({
      startCapture: captureFailure ? throwThunk(new Error(`${name} failed`))
        : captureStopFailure ? async () => async () => { throw new Error(`${name} failed`); }
          : okThunk({ started: 0, stopped: 0 }),
      startRecording: okThunk({ started: 0, stopped: 0 }),
      engine, captureFaultTerminal: true, onFault: (stage) => faults.push(stage), retry: { attempts: 1, delayMs: 0 },
    });
    await live.start();
    let rejected = false;
    try { await live.stop(); } catch { rejected = true; }
    check(`${name}: active composition stays seated then rejects terminal success`,
      rejected && faults.length === 1 && engine.resourceCounts === undefined, JSON.stringify(faults));
  }

  console.log(failed === 0 ? '\n✅ live-pipeline: all passed' : `\n❌ live-pipeline: ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
