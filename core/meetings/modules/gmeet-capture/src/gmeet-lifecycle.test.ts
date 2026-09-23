import assert from 'node:assert/strict';

class Track {
  id: string; readyState: 'live' | 'ended' = 'live'; private listeners = new Set<() => void>();
  constructor(id: string) { this.id = id; }
  addEventListener(type: string, listener: () => void) { if (type === 'ended') this.listeners.add(listener); }
  removeEventListener(type: string, listener: () => void) { if (type === 'ended') this.listeners.delete(listener); }
  end() { this.readyState = 'ended'; for (const listener of this.listeners) listener(); }
}
class Stream { constructor(readonly id: string, readonly track: Track) {} getAudioTracks() { return [this.track] as any; } }
class Source { disconnected = 0; connect() {} disconnect() { this.disconnected++; } }
class Context {
  static all: Context[] = []; static failWorklet = false; state = 'running'; sources: Source[] = []; closed = 0;
  audioWorklet = { addModule: async (_url: string) => { if (Context.failWorklet) throw new Error('https://private.example Authorization: Bearer secret'); } };
  constructor(_opts?: unknown) { Context.all.push(this); }
  resume = async () => {};
  createMediaStreamSource = (_stream: unknown) => { const source = new Source(); this.sources.push(source); return source as any; };
  close = async () => { this.state = 'closed'; this.closed++; };
  get destination() { return {}; }
}
class WorkletNode {
  static all: WorkletNode[] = []; disconnected = 0; port = { onmessage: null as any, close() {} };
  constructor(_ctx: unknown, _name: string, _opts: unknown) { WorkletNode.all.push(this); }
  connect() {} disconnect() { this.disconnected++; }
}
const elements: any[] = [];
const present = new Set<any>();
(globalThis as any).MediaStream = Stream;
(globalThis as any).AudioContext = Context;
(globalThis as any).AudioWorkletNode = WorkletNode;
(globalThis as any).document = { querySelectorAll: () => elements, contains: (el: any) => present.has(el) };
(globalThis as any).URL = { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} };

const { createGmeetCapture } = await import('./gmeet-capture.js');
const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const el = (stream: Stream) => ({ paused: false, srcObject: stream });

const firstStream = new Stream('first', new Track('first-track'));
const first = el(firstStream);
const firstMirror = el(firstStream);
elements.push(first, firstMirror); present.add(first); present.add(firstMirror);
const capture = createGmeetCapture({ onAudio() {}, rescanMs: 1, findRetries: 1 });
await capture.start(); await wait();
assert.deepEqual(capture.resourceCounts(), { contexts: 1, sources: 1, worklets: 1, tracks: 1, references: 2 });

present.delete(first); await wait();
assert.deepEqual(capture.resourceCounts(), { contexts: 1, sources: 1, worklets: 1, tracks: 1, references: 1 });

firstStream.track.end();
assert.deepEqual(capture.resourceCounts(), { contexts: 1, sources: 0, worklets: 0, tracks: 0, references: 0 });

const second = el(new Stream('second', new Track('second-track')));
elements.push(second); present.add(second); await wait();
assert.deepEqual(capture.resourceCounts(), { contexts: 1, sources: 1, worklets: 1, tracks: 1, references: 1 });
second.srcObject = new Stream('replacement', new Track('replacement-track')); await wait();
assert.deepEqual(capture.resourceCounts(), { contexts: 1, sources: 1, worklets: 1, tracks: 1, references: 1 });
present.delete(second); await wait();
assert.deepEqual(capture.resourceCounts(), { contexts: 1, sources: 0, worklets: 0, tracks: 0, references: 0 });
capture.stop(); capture.stop();
assert.deepEqual(capture.resourceCounts(), { contexts: 0, sources: 0, worklets: 0, tracks: 0, references: 0 });
assert.equal(Context.all.length, 1, 'churn shares one AudioContext');
assert.equal(Context.all[0].closed, 1, 'stop closes the shared context once');

Context.failWorklet = true;
const unsafe = el(new Stream('unsafe', new Track('unsafe-track')));
elements.push(unsafe); present.add(unsafe);
const logs: string[] = [];
const failingCapture = createGmeetCapture({ onAudio() {}, log: (line) => logs.push(line), rescanMs: 1, findRetries: 1 });
await failingCapture.start(); await wait();
assert(logs.some((line) => line === 'worklet init failed code=worklet_init_failed'));
assert(!logs.join('\n').includes('private.example') && !logs.join('\n').includes('Bearer secret'));
assert.deepEqual(failingCapture.resourceCounts(), { contexts: 1, sources: 0, worklets: 0, tracks: 0, references: 0 });
failingCapture.stop();
console.log('PASS gmeet lifecycle: mirrors deduplicate and end/remove/replacement/stop release every owned resource');
