import assert from 'node:assert/strict';
import { ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES, createHttpAttributedAudioRecorder } from './attributed-audio.js';

const originalFetch = globalThis.fetch;
let uploads = 0;
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method === 'GET') return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  if (path.endsWith('/upload')) {
    uploads++;
    assert.ok(init?.signal, 'real adapter attaches an abort signal to every request');
    return await new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('stalled upload aborted')), 1));
  }
  const form = init?.body as FormData | undefined;
  const metadata = form?.get('range_metadata');
  const range = typeof metadata === 'string' ? JSON.parse(metadata) : {};
  if (path.endsWith('/reserve')) return Response.json({ ...range, state: 'sealed' });
  if (path.endsWith('/fail')) return Response.json({ ...range, state: 'failed' });
  return Response.json({ state: 'closed' });
};

try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { requestTimeoutMs: 5 });
  assert.ok(recorder);
  await recorder.ready;
  // 25 one-MiB channels are offered while HTTP is stalled. The adapter reserves every multipart
  // copy before admission, so it never retains the old ~50MiB while claiming ~25MiB.
  for (let channel = 0; channel < 25; channel++) recorder.feed({ channel, speaker_key: `channel:${channel}`, speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(256 * 1024), capture_ms: channel, sample_rate: 16_000 });
  assert.ok(recorder.retainedBytes() <= ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES);
  const manifest = await recorder.stop();
  assert.ok(uploads > 0);
  assert.equal(recorder.retainedBytes(), 0);
  assert.ok(manifest.ranges.some(range => range.state === 'failed'));
} finally {
  globalThis.fetch = originalFetch;
}
console.log('attributed HTTP adapter memory and timeout fence passes');
