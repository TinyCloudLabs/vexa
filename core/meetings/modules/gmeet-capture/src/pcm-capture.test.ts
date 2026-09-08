/** The actual worklet program: PCM continuity and buffer ownership across its port. */
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { WORKLET_SRC } from './pcm-capture.js';

const received: Float32Array[] = [];
const senderLengths: number[] = [];
let Processor: any;
runInNewContext(WORKLET_SRC, {
  Float32Array,
  AudioWorkletProcessor: class {
    port = {
      postMessage(frame: Float32Array, transfer?: ArrayBuffer[]) {
        received.push(structuredClone(frame, { transfer: transfer ?? [] }));
        senderLengths.push(frame.byteLength);
      },
    };
  },
  registerProcessor(_name: string, ctor: any) { Processor = ctor; },
});

const processor = new Processor();
// Multiple worklet quanta and output blocks catch both reuse-after-transfer and
// samples dropped at the 4096-frame boundary. Every input sample is distinguishable.
for (let quantum = 0; quantum < 96; quantum++) {
  const input = Float32Array.from({ length: 128 }, (_, i) => quantum * 128 + i);
  assert.equal(processor.process([[input]]), true);
}
assert.equal(received.length, 3);
for (let block = 0; block < received.length; block++) {
  assert.equal(received[block].length, 4096);
  for (let i = 0; i < 4096; i++) assert.equal(received[block][i], block * 4096 + i);
}
assert(senderLengths.every(length => length === 0), 'posted PCM buffers must detach from the audio thread');
assert.equal(processor._buf.byteLength, 16384, 'the next block owns a fresh writable buffer');
console.log('PASS worklet: exact PCM continuity and transferred buffer ownership');
