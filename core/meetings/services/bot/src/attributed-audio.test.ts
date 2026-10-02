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
  }, { requestTimeoutMs: 5, retryDelaysMs: [0] });
  assert.ok(recorder);
  await recorder.ready;
  // 25 one-MiB channels are offered while HTTP is stalled. The adapter reserves every multipart
  // copy before admission, so it never retains the old ~50MiB while claiming ~25MiB.
  for (let channel = 0; channel < 25; channel++) recorder.feed({ channel, speaker_key: `channel:${channel}`, speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(256 * 1024), capture_ms: channel, sample_rate: 16_000 });
  assert.ok(recorder.retainedBytes() <= ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES);
  // A bounded retry still fails when every attempt stalls; the durably failed ranges close the
  // manifest rather than faulting the recorder terminally.
  const manifest = await recorder.stop();
  assert.equal(manifest.state, 'closed');
  assert.ok(manifest.ranges.length > 0);
  assert.ok(manifest.ranges.every(range => range.state === 'failed'), JSON.stringify(manifest.ranges));
  assert.ok(uploads > 0);
  assert.equal(recorder.retainedBytes(), 0);
} finally {
  globalThis.fetch = originalFetch;
}

// The durable producer's real HTTP close boundary is not a best-effort success.  A server-side
// 409 remains an active-phase fault until cleanup and must therefore make the later lifecycle exit
// fail instead of publishing an empty closed manifest.
let close409 = 0;
globalThis.fetch = async (input, init) => {
  if (init?.method === 'GET') {
    return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  }
  if (String(input).endsWith('/close')) { close409++; return new Response('ledger conflict', { status: 409 }); }
  return Response.json({});
};
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, recordingEnabled: true, attributedAudioEnabled: true,
    meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [0] });
  assert.ok(recorder);
  await recorder.ready;
  await assert.rejects(recorder.stop(), /attributed-audio close failed \(code http status 409\)/);
  assert.equal(recorder.retainedBytes(), 0);
  assert.equal(close409, 1, 'a deterministic 4xx conflict is not retried');
} finally {
  globalThis.fetch = originalFetch;
}

// Upstream storage errors may contain credentials, paths, PCM metadata, or arbitrary response
// bodies. The bot boundary must retain only its bounded stage/status vocabulary.
let close502 = 0;
globalThis.fetch = async (input, init) => {
  if (init?.method === 'GET') {
    return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  }
  if (String(input).endsWith('/close')) { close502++; return new Response('s3://secret-bucket/a.pcm Authorization: Bearer secret', { status: 502 }); }
  return Response.json({});
};
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [0] });
  assert.ok(recorder);
  await recorder.ready;
  await assert.rejects(recorder.stop(), (error: unknown) => {
    const message = String(error);
    return message === 'AttributedAudioRequestError: attributed-audio close failed (code http status 502)'
      && !message.includes('secret-bucket') && !message.includes('Authorization');
  });
  assert.equal(close502, 2, 'a 5xx close is retried within the configured bound');
} finally {
  globalThis.fetch = originalFetch;
}

// Network and JSON parser exceptions are equally untrusted. Neither reaches terminal state or a
// log line verbatim; the only durable vocabulary is stage + code (+ HTTP status when present).
globalThis.fetch = async () => { throw new Error('https://private.example/a.pcm Bearer secret transcript text'); };
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [0] });
  assert.ok(recorder);
  await assert.rejects(recorder.ready, (error: unknown) => String(error) === 'AttributedAudioRequestError: attributed-audio manifest failed (code network)');
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async () => new Response('private parser body', { status: 200, headers: { 'content-type': 'application/json' } });
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  });
  assert.ok(recorder);
  await assert.rejects(recorder.ready, (error: unknown) => String(error) === 'AttributedAudioRequestError: attributed-audio manifest failed (code invalid_response)');
} finally {
  globalThis.fetch = originalFetch;
}

// TC-560: one upload that times out on every bounded attempt mid-meeting. The range lands as a
// durable 'failed' row, later frames are still admitted, and the manifest still closes — the
// transient fault no longer poisons the rest of the meeting.
const ledger = new Map<string, { sequence: number; state: string; path?: string }>();
const uploadAttempts = new Map<number, number>();
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method === 'GET') {
    return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  }
  const form = init?.body as FormData | undefined;
  const range = typeof form?.get('range_metadata') === 'string' ? JSON.parse(form.get('range_metadata') as string) : {};
  if (path.endsWith('/reserve')) {
    ledger.set(range.idempotency_key, { sequence: range.sequence, state: 'sealed', path: `/meetings/1/attributed-audio/ranges/${range.sequence}` });
    return Response.json({ ...range, state: 'sealed', path: `/meetings/1/attributed-audio/ranges/${range.sequence}` });
  }
  if (path.endsWith('/upload')) {
    uploadAttempts.set(range.sequence, (uploadAttempts.get(range.sequence) ?? 0) + 1);
    if (range.sequence === 0) throw new Error('injected mid-meeting upload timeout');
    const row = ledger.get(range.idempotency_key)!;
    row.state = 'uploaded';
    return Response.json({ path: row.path });
  }
  if (path.endsWith('/fail')) {
    ledger.get(range.idempotency_key)!.state = 'failed';
    return Response.json({ ...range, state: 'failed' });
  }
  if (path.endsWith('/close')) return Response.json({ state: 'closed' });
  return Response.json({});
};
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [0], warn: () => {} });
  assert.ok(recorder);
  await recorder.ready;
  const tcFrame = (channel: number, capture_ms: number) =>
    ({ channel, speaker_key: `channel:${channel}`, speaker_name: '', attribution: { source: 'unresolved' as const, confidence: 0 }, pcm: new Float32Array(10), capture_ms, sample_rate: 100 });
  recorder.feed(tcFrame(0, 1_000));
  recorder.feed(tcFrame(0, 2_000));   // scheduling gap seals seq0 while capture continues
  await new Promise(resolve => setImmediate(resolve)); // the failed upload settles durably
  recorder.feed(tcFrame(1, 3_000));   // a poisoned recorder would reject this frame
  const closed = await recorder.stop();
  assert.equal(closed.state, 'closed');
  assert.equal(uploadAttempts.get(0), 2, 'the timed-out upload is retried within the bound, then fails durably');
  assert.deepEqual([...ledger.values()].map(row => row.state), ['failed', 'uploaded', 'uploaded']);
  assert.ok(uploadAttempts.get(1)! > 0 && uploadAttempts.get(2)! > 0, 'later ranges still reach the upload stage');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('attributed HTTP adapter memory and timeout fence passes');
