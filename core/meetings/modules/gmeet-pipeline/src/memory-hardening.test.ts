import assert from 'node:assert/strict';
import { SpeakerStreamManager } from './speaker-streams.js';

const manager = new SpeakerStreamManager({ minAudioDuration: 60, submitInterval: 60 });
for (let i = 0; i < 400; i++) {
  const id = `channel-${i}:turn-${i}`;
  manager.addSpeaker(id, `Speaker ${i}`);
  manager.feedAudio(id, new Float32Array(128).fill(0.1));
  manager.removeSpeaker(id);
}
assert.deepEqual(manager.resourceCounts(), {
  speakers: 0, timers: 0, generations: 0, carriedSamples: 0, retainedPcmBytes: 0,
});
manager.removeAll();
assert.deepEqual(manager.resourceCounts(), {
  speakers: 0, timers: 0, generations: 0, carriedSamples: 0, retainedPcmBytes: 0,
});
console.log('PASS speaker-stream churn: 400 removed turns leave no maps, timers, or PCM');
