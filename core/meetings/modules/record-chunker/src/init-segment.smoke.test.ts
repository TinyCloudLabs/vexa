/**
 * init-segment.smoke — the chunker must never let the webm EBML init segment be lost.
 *
 * FIELD BUG: MediaRecorder emits a self-describing chunk 0 (EBML `1a 45 df a3` + Segment +
 * Tracks + first Cluster) then cluster-only chunks. If chunk 0's send over the page→Node base64
 * bridge fails (the largest blob's `onChunk` callback dropped), the server assembles a headerless
 * master from the cluster-only survivors — `43 b6 75 …` mid-Matroska, which no player accepts.
 *
 * The chunker fix: retain the init segment from the first header-bearing blob, and — until a
 * header-bearing chunk has been ACK'd by `onChunk` — PREPEND the retained init segment to the
 * next surviving cluster chunk. So a surviving chunk always re-forms a valid self-describing
 * webm even when chunk 0 itself never made it across.
 *
 * No assertion lib — same tsx + exit-code shape as chunker.smoke.test.ts.
 */

// ── browser-global stubs (installed before importing the brick) ──────────────────
const enc = (s: string): string => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).btoa = (s: string) => enc(s);
(globalThis as any).window = { logBot: (_m: string) => {} };

class FakeBlob {
  constructor(private bytes: Uint8Array) {}
  get size() { return this.bytes.length; }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}
class FakeMediaRecorder {
  static isTypeSupported(mime: string) { return mime === 'audio/webm;codecs=opus'; }
  onstart: (() => void) | null = null;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  constructor(_stream: any, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? ''; }
  start(_timeslice?: number) { this.state = 'recording'; this.onstart?.(); }
  pause() { if (this.state === 'recording') this.state = 'paused'; }
  resume() { if (this.state === 'paused') this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  emit(bytes: Uint8Array) { this.ondataavailable?.({ data: new FakeBlob(bytes) }); }
}
(globalThis as any).MediaRecorder = FakeMediaRecorder;
(globalThis as any).window.MediaRecorder = FakeMediaRecorder;

import { MediaRecorderChunker, type RecordingChunk } from './index';

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const startsWith = (a: Uint8Array, sig: number[]) => sig.every((v, i) => a[i] === v);

const headerBlob = new Uint8Array([...EBML, 0x42, 0x86, 0x81, 0x01, ...CLUSTER, 0xaa]); // chunk 0
const clusterBlob = (t: number) => new Uint8Array([...CLUSTER, t, t + 1, t + 2]);       // cluster-only

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

async function main() {
  // ── 1) HAPPY PATH: chunk 0 delivered fine → it carries the header; no re-attach on cluster 1. ──
  {
    const got: RecordingChunk[] = [];
    const chunker = new MediaRecorderChunker({
      stream: {} as any, timesliceMs: 1000,
      onChunk: async (c) => { got.push(c); return true; },
    });
    await chunker.start();
    const mr = chunker.getMediaRecorder() as unknown as FakeMediaRecorder;
    mr.emit(headerBlob);
    mr.emit(clusterBlob(0x10));
    await new Promise((r) => setTimeout(r, 10));
    check('happy: chunk 0 carries EBML header', !!got[0] && startsWith(decode(got[0].base64), EBML));
    check('happy: chunk 1 stays cluster-only (no header duplication)',
      !!got[1] && startsWith(decode(got[1].base64), CLUSTER) && !startsWith(decode(got[1].base64), EBML),
      got[1] ? Buffer.from(decode(got[1].base64)).toString('hex') : 'no chunk1');
  }

  // ── 2) A bridge rejection is terminal. A later final marker would claim a complete recording
  //        after an admitted chunk was lost, so it must never be repaired by silently splicing it. ──
  {
    const got: RecordingChunk[] = [];
    let firstSeen = false;
    const chunker = new MediaRecorderChunker({
      stream: {} as any, timesliceMs: 1000,
      onChunk: async (c) => {
        // Fail ONLY the first delivery (the header-bearing chunk 0) — model the dropped big blob.
        if (!firstSeen) { firstSeen = true; throw new Error('bridge RPC dropped chunk 0'); }
        got.push(c);
        return true;
      },
    });
    await chunker.start();
    const mr = chunker.getMediaRecorder() as unknown as FakeMediaRecorder;
    mr.emit(headerBlob);
    await new Promise((r) => setTimeout(r, 10));
    check('field: rejected admitted header is a terminal recording failure', chunker.resourceCounts().failed);
    check('field: no later chunk is silently sent after bridge rejection', got.length === 0, JSON.stringify(got));
  }

  // ── 3) ONCE DELIVERED, never re-attach: after a header-bearing chunk is ACK'd, later clusters
  //        stay cluster-only (no duplicate headers bloating the stream). ──
  {
    const got: RecordingChunk[] = [];
    const chunker = new MediaRecorderChunker({
      stream: {} as any, timesliceMs: 1000,
      onChunk: async (c) => { got.push(c); return true; },
    });
    await chunker.start();
    const mr = chunker.getMediaRecorder() as unknown as FakeMediaRecorder;
    mr.emit(headerBlob);          // delivered OK → init segment delivered
    await new Promise((r) => setTimeout(r, 10));
    mr.emit(clusterBlob(0x30));
    mr.emit(clusterBlob(0x40));
    await new Promise((r) => setTimeout(r, 10));
    const headerCount = got.filter((c) => startsWith(decode(c.base64), EBML)).length;
    check('once-delivered: exactly ONE chunk carries the EBML header (no duplication)',
      headerCount === 1, `headerCount=${headerCount}`);
  }

  if (failed) { console.error(`\n❌ init-segment.smoke: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ init-segment.smoke: successful chunks preserve the EBML init segment once, while a rejected admitted chunk fails terminally rather than claiming completion.');
  process.exit(0);
}

main().catch((e) => { console.error('❌ FAIL —', e?.message || e); process.exit(1); });
