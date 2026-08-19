/**
 * dynamic-tap.smoke — the DYNAMIC recording mix in isolation (no browser).
 *
 * Pins the fix for the two batch-recording defects the static combine had
 * (TinyCloud fork, branch `tinycloud`):
 *   1. a participant whose audio track arrives AFTER the tap starts must be
 *      attached to the recording mix (the live mixer already rescans; the tap
 *      now mirrors that mechanism);
 *   2. the tap must START even when ZERO audio-bearing media elements exist at
 *      join (the destination stream records silence until audio appears);
 *   3. track removal (ended tracks / element gone from DOM) must detach
 *      WITHOUT crashing the recording.
 *
 * Same shape as chunker.smoke.test.ts — stubbed browser globals, real class,
 * tsx + exit code, no assertion lib.
 */

// ── browser-global stubs (installed before importing the brick) ────────────────
(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).window = { logBot: (_m: string) => {} };

class FakeTrack { readyState: 'live' | 'ended' = 'live'; }
class FakeMediaStream {
  id = Math.random().toString(36).slice(2);
  constructor(private tracks: FakeTrack[] = [new FakeTrack()]) {}
  getAudioTracks() { return this.tracks; }
  endAll() { for (const t of this.tracks) t.readyState = 'ended'; }
}
(globalThis as any).MediaStream = FakeMediaStream;

/** A fake media element with a srcObject stream. */
class FakeMediaElement {
  paused = false;
  constructor(public srcObject: FakeMediaStream | null) {}
}

const pageElements: FakeMediaElement[] = [];
(globalThis as any).document = {
  querySelectorAll: (_sel: string) => [...pageElements],
  contains: (el: any) => pageElements.includes(el),
};

const connected: any[] = [];
class FakeSourceNode {
  disconnected = false;
  constructor(public stream: any) {}
  connect(_dest: any) { connected.push(this); }
  disconnect() { this.disconnected = true; const i = connected.indexOf(this); if (i >= 0) connected.splice(i, 1); }
}
class FakeAudioContext {
  state = 'running';
  resume() { /* */ }
  close() { (this as any).state = 'closed'; }
  createMediaStreamDestination() { return { stream: new FakeMediaStream() }; }
  createMediaStreamSource(s: any) { return new FakeSourceNode(s); }
}
(globalThis as any).AudioContext = FakeAudioContext;

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(mime: string) { return mime === 'audio/webm;codecs=opus'; }
  onstart: (() => void) | null = null;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  constructor(public stream: any, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }
  start(_ts?: number) { this.state = 'recording'; this.onstart?.(); }
  stop() { this.state = 'inactive'; this.onstop?.(); }
}
(globalThis as any).MediaRecorder = FakeMediaRecorder;
(globalThis as any).window.MediaRecorder = FakeMediaRecorder;

// import AFTER globals exist
import { createRecordingTap, type RecordingChunk } from './index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};

async function main() {
  const got: RecordingChunk[] = [];
  const RESCAN = 20;

  // 1. ZERO elements at start — the tap must still start the recorder.
  const tap = createRecordingTap({
    rescanMs: RESCAN,
    timesliceMs: 1000,
    onChunk: (c) => { got.push(c); return true; },
  });
  await tap.start();
  const rec = FakeMediaRecorder.instances[0];
  check(!!rec && rec.state === 'recording', 'empty room: MediaRecorder started with zero media elements');
  check(connected.length === 0, 'empty room: nothing attached yet');

  // 2. LATE JOINER — an element appearing after start must be attached by the rescan.
  const bob = new FakeMediaElement(new FakeMediaStream());
  pageElements.push(bob);
  await sleep(RESCAN * 3);
  check(connected.length === 1 && connected[0].stream === bob.srcObject, 'late joiner: element attached to the mix after tap start');

  // 3. srcObject SWAP — a new stream on the same element replaces the old attachment.
  const bob2 = new FakeMediaStream();
  bob.srcObject = bob2;
  await sleep(RESCAN * 3);
  check(connected.length === 1 && connected[0].stream === bob2, 'swap: new srcObject re-attached, old source disconnected');

  // 4. TRACK REMOVAL — ended tracks detach without crashing; recorder keeps recording.
  bob2.endAll();
  await sleep(RESCAN * 3);
  check(connected.length === 0, 'removal: ended tracks detached');
  check(rec.state === 'recording', 'removal: recorder still recording after detach');

  // 5. A SECOND late element still attaches after the removal.
  const carol = new FakeMediaElement(new FakeMediaStream());
  pageElements.push(carol);
  await sleep(RESCAN * 3);
  check(connected.length === 1 && connected[0].stream === carol.srcObject, 'post-removal: next late element attaches');

  // 6. stop() — final chunk emitted, rescan halted, no further attaches.
  await tap.stop();
  check(got.length === 1 && got[0].isFinal === true, 'stop: exactly one final chunk emitted');
  pageElements.push(new FakeMediaElement(new FakeMediaStream()));
  const before = connected.length;
  await sleep(RESCAN * 3);
  check(connected.length === before, 'stop: rescan halted (no attach after stop)');

  if (failures) { console.error(`\n❌ dynamic-tap.smoke: ${failures} check(s) failed`); process.exit(1); }
  console.log('\n✅ dynamic-tap.smoke: the tap starts empty, attaches late joiners, survives removal, and stops clean.');
}

main().catch((e) => { console.error(e); process.exit(1); });
