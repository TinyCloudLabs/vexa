/**
 * Google Meet per-participant audio capture — THE shared implementation.
 *
 * Pure browser code (no Node, no Playwright). Consumed by BOTH:
 *  - the bot: bundled into browser-utils.global.js; index.ts installs it in-page
 *    and feeds onAudio → __vexaPerSpeakerAudioData (the Playwright bridge).
 *  - the extension: imported by inpage.ts; onAudio → postMessage to the WS.
 *
 * Google Meet renders each participant's audio as a separate <audio>/<video>
 * element whose srcObject is a live MediaStream. This wires each into a
 * shared AudioContext → AudioWorklet, resampled to 16 kHz, and delivers
 * per-element PCM chunks via onAudio(index, pcm). It rescans for late joiners /
 * recycled elements and silence-gates each chunk. The track index is stable per
 * stream id (the basis for per-track speaker attribution in gmeet-speakers.ts).
 */

import { createPcmCaptureNode } from './pcm-capture.js';

export interface GmeetCaptureOptions {
  /** One per-track PCM chunk (already 16 kHz). index is the stable track index. */
  onAudio: (index: number, pcm: Float32Array) => void;
  log?: (msg: string) => void;
  targetSampleRate?: number;   // default 16000
  bufferSize?: number;         // default 4096
  silenceThreshold?: number;   // default 0.005 — skip near-silent chunks
  rescanMs?: number;           // default 15000 — discover late joiners
  findRetries?: number;        // default 10
  findDelayMs?: number;        // default 2000
}

export interface GmeetCapture {
  start(): Promise<void>;
  stop(): void;
  /** Number of currently-connected participant streams. */
  streamCount(): number;
  /** Bounded resource accounting used by the long-meeting probe. */
  resourceCounts(): { contexts: number; sources: number; worklets: number; tracks: number; references: number };
}

export function createGmeetCapture(opts: GmeetCaptureOptions): GmeetCapture {
  const log = opts.log || (() => { /* silent */ });
  const SR = opts.targetSampleRate ?? 16000;
  const SILENCE = opts.silenceThreshold ?? 0.005;
  const RESCAN = opts.rescanMs ?? 15000;
  const FIND_RETRIES = opts.findRetries ?? 10;
  const FIND_DELAY = opts.findDelayMs ?? 2000;

  let running = false;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  interface Connection {
    stream: MediaStream;
    track: MediaStreamTrack;
    elements: Map<HTMLMediaElement, MediaStream>;
    source: MediaStreamAudioSourceNode;
    node: AudioWorkletNode | null;
    onEnded: () => void;
  }
  interface ElementBinding {
    stream: MediaStream;
    connection: Connection;
  }
  // Capture resources belong to the audio track, not to a DOM element. Meet can
  // temporarily mirror one MediaStream through several elements while recycling
  // tiles; element-keyed ownership would capture identical PCM more than once.
  // Chromium may return a new JS MediaStreamTrack wrapper on a later scan, so use
  // its stable browser id rather than wrapper identity for this owner registry.
  const connections = new Map<string, Connection>();
  const bindings = new Map<HTMLMediaElement, ElementBinding>();
  let context: AudioContext | null = null;
  let nextIndex = 0;

  function findMediaElements(): HTMLMediaElement[] {
    return Array.from(document.querySelectorAll('audio, video')).filter((el: any) =>
      (typeof document.contains !== 'function' || document.contains(el)) &&
      !el.paused &&
      el.srcObject instanceof MediaStream &&
      el.srcObject.getAudioTracks().some((track: MediaStreamTrack) => track.readyState !== 'ended')
    ) as HTMLMediaElement[];
  }

  function release(connection: Connection, reason: string): void {
    // Remove the listener before disconnecting so a stop/close cascade cannot retain this
    // connection through the track. Every path (end, detach, replacement, failed init, stop)
    // comes through here; it is deliberately idempotent.
    if (connections.get(connection.track.id) !== connection) return;
    connections.delete(connection.track.id);
    for (const el of connection.elements.keys()) {
      if (bindings.get(el)?.connection === connection) bindings.delete(el);
    }
    connection.elements.clear();
    try { connection.track.removeEventListener('ended', connection.onEnded); } catch { /* */ }
    try { connection.node?.port.close(); } catch { /* */ }
    try { connection.node?.disconnect(); } catch { /* */ }
    try { connection.source.disconnect(); } catch { /* */ }
    log(`stream released (${reason})`);
  }

  function detachElement(el: HTMLMediaElement, binding: ElementBinding, reason: string): void {
    if (bindings.get(el) !== binding) return;
    bindings.delete(el);
    binding.connection.elements.delete(el);
    if (binding.connection.elements.size === 0) release(binding.connection, reason);
    else log(`stream mirror detached (${reason}; ${binding.connection.elements.size} reference(s) remain)`);
  }

  function releaseAll(reason: string): void {
    for (const connection of Array.from(connections.values())) release(connection, reason);
  }

  function ensureContext(): AudioContext {
    if (!context || context.state === 'closed') {
      context = new AudioContext({ sampleRate: SR });
      void context.resume().then(() => log(`capture ctx.state=${context?.state}`)).catch(() => { /* */ });
    }
    return context;
  }

  function connectElement(el: HTMLMediaElement, index: number): boolean {
    try {
      const stream: MediaStream = (el as any).srcObject;
      if (!stream || stream.getAudioTracks().length === 0) return false;
      const track = stream.getAudioTracks()[0];
      const existing = bindings.get(el);
      if (existing?.stream === stream && existing.connection.track.id === track.id) return false;
      if (existing) detachElement(el, existing, 'replacement');

      const shared = connections.get(track.id);
      if (shared) {
        shared.elements.set(el, stream);
        bindings.set(el, { stream, connection: shared });
        log(`stream mirror attached (track ${track.id.substring(0, 8)}; ${shared.elements.size} reference(s))`);
        return false;
      }

      const ctx = ensureContext();
      const source = ctx.createMediaStreamSource(stream);
      // AudioWorklet (audio-thread) instead of the deprecated ScriptProcessor,
      // which duplicates/drops buffers under main-thread load — the captured-audio
      // stutter. connectElement is sync, so wire the node when addModule resolves.
      let seen = 0, emitted = 0; // L4 frame-flow diagnostic
      const connection: Connection = {
        stream, track, elements: new Map([[el, stream]]), source, node: null,
        onEnded: () => release(connection, 'track ended'),
      };
      connections.set(track.id, connection);
      bindings.set(el, { stream, connection });
      track.addEventListener('ended', connection.onEnded);
      createPcmCaptureNode(ctx, (data) => {
        if (!running || connections.get(track.id) !== connection) return;
        seen++;
        let maxVal = 0;
        for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > maxVal) maxVal = a; }
        if (maxVal > SILENCE) { emitted++; if (emitted === 1 || emitted % 100 === 0) log(`stream ${index} AUDIO seen=${seen} emitted=${emitted} max=${maxVal.toFixed(3)}`); opts.onAudio(index, data); } // worklet already yields a fresh copy
        else if (seen % 250 === 0) log(`stream ${index} silent seen=${seen} emitted=${emitted} max=${maxVal.toFixed(4)} ctx=${ctx.state}`);
      }).then((node) => {
        // stop/replacement can happen while addModule() is pending. Never attach a late node.
        if (!running || connections.get(track.id) !== connection) {
          try { node.port.close(); node.disconnect(); } catch { /* */ }
          return;
        }
        connection.node = node;
        source.connect(node);
        node.connect(ctx.destination);
      }).catch((err: any) => {
        release(connection, 'worklet init failed');
        log(`worklet init failed: ${err?.message ?? err}`);
      });

      log(`stream ${index} connected (track ${track.id.substring(0, 8)})`);
      return true;
    } catch (err: any) {
      log(`stream ${index} error: ${err.message}`);
      return false;
    }
  }

  function retainLiveOwners(elements: HTMLMediaElement[]): void {
    // An element may change to B before a later DOM sibling that still references A is
    // visited. Retain every already-owned target first, so replacing that first element
    // cannot release A between the two discoveries.
    for (const el of elements) {
      const stream: MediaStream = (el as any).srcObject;
      const track = stream?.getAudioTracks()[0];
      const existing = bindings.get(el);
      const shared = track && connections.get(track.id);
      if (shared && (!existing || existing.stream !== stream || existing.connection.track.id !== track.id))
        shared.elements.set(el, stream);
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;

      let mediaElements: HTMLMediaElement[] = [];
      for (let attempt = 0; attempt < FIND_RETRIES && running; attempt++) {
        mediaElements = findMediaElements();
        if (mediaElements.length > 0) break;
        await new Promise(r => setTimeout(r, FIND_DELAY));
      }
      if (!running) return;

      for (let i = 0; i < mediaElements.length; i++) {
        if (connectElement(mediaElements[i], i)) nextIndex = i + 1;
      }
      nextIndex = Math.max(nextIndex, mediaElements.length);

      rescanTimer = setInterval(() => {
        if (!running) return;
        const mediaElements = findMediaElements();
        // First retain all desired references that already have an owner. A DOM-ordered scan can
        // otherwise release A while the earlier element changes to B, before its later A mirror
        // is visited and attached. Only after that pre-registration may replacements release.
        retainLiveOwners(mediaElements);
        for (const el of mediaElements) if (connectElement(el, nextIndex)) nextIndex++;
        // A removed element or swapped srcObject must not pin its old source once all surviving
        // references have been reconciled.
        for (const [el, binding] of Array.from(bindings.entries())) {
          const connection = binding.connection;
          const inDom = typeof document.contains !== 'function' || document.contains(el);
          const live = connection.track.readyState !== 'ended';
          if (!inDom || !live || (el as any).srcObject !== binding.stream)
            detachElement(el, binding, !inDom ? 'element removed' : !live ? 'track ended' : 'replacement');
        }
      }, RESCAN);

      log(`capture started with ${connections.size} stream(s)`);
    },

    stop(): void {
      running = false;
      if (rescanTimer !== null) { clearInterval(rescanTimer); rescanTimer = null; }
      releaseAll('stop');
      const ctx = context;
      context = null;
      try { void ctx?.close(); } catch { /* ignore */ }
      nextIndex = 0;
      log('capture stopped');
    },

    streamCount(): number { return connections.size; },
    resourceCounts() {
      let worklets = 0;
      let references = 0;
      for (const connection of connections.values()) {
        if (connection.node) worklets++;
        references += connection.elements.size;
      }
      return { contexts: context ? 1 : 0, sources: connections.size, worklets, tracks: connections.size, references };
    },
  };
}
