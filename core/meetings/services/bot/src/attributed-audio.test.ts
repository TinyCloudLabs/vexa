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

// Retry-After is honored on 429/503 but never stretches past the configured attempt bound: this
// 429 advertises an hour, the bound holds it to one bounded retry, and the run ends in ms.
let retryAfterCalls = 0;
globalThis.fetch = async (input, init) => {
  if (init?.method === 'GET') return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  if (String(input).endsWith('/close')) { retryAfterCalls++; return new Response('throttled', { status: 429, headers: { 'retry-after': '3600' } }); }
  return Response.json({});
};
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [5], warn: () => {} });
  assert.ok(recorder);
  await recorder.ready;
  await assert.rejects(recorder.stop(), /attributed-audio close failed \(code http status 429\)/);
  assert.equal(retryAfterCalls, 2, 'a 429 is retried once within the bound despite a one-hour Retry-After');
} finally {
  globalThis.fetch = originalFetch;
}

// Retry-After is a floor, not a jitter ceiling: a 429 advertising one second with a two-second
// bound must wait ≥1 s before retrying — a ceiling would fire inside the cooldown and burn the
// attempt. One real second is spent here because the header's granularity is seconds and the
// wait itself is the observable behavior.
let floorCalls = 0;
globalThis.fetch = async (input, init) => {
  if (init?.method === 'GET') return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  if (String(input).endsWith('/close')) {
    floorCalls++;
    return floorCalls === 1 ? new Response('throttled', { status: 429, headers: { 'retry-after': '1' } }) : Response.json({ state: 'closed' });
  }
  return Response.json({});
};
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [2_000], warn: () => {} });
  assert.ok(recorder);
  await recorder.ready;
  const started = Date.now();
  const closed = await recorder.stop();
  assert.equal(closed.state, 'closed');
  assert.equal(floorCalls, 2, 'the hinted retry succeeds instead of exhausting attempts in the cooldown');
  assert.ok(Date.now() - started >= 1_000, `retry fired ${Date.now() - started}ms into a 1s cooldown`);
} finally {
  globalThis.fetch = originalFetch;
}

// fetch() resolves on headers: a body stream that dies mid-read is a transport failure the
// server may already have acted on (here: the close is durably recorded but its acknowledgement
// is lost). The request retries under the same bounded policy and the receipt still lands.
let closeReads = 0;
globalThis.fetch = async (input, init) => {
  if (init?.method === 'GET') return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  if (String(input).endsWith('/close')) {
    closeReads++;
    if (closeReads === 1) return new Response(new ReadableStream({ start: controller => controller.error(new Error('connection reset mid-body')) }), { status: 200 });
    return Response.json({ state: 'closed' });
  }
  return Response.json({});
};
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [0], warn: () => {} });
  assert.ok(recorder);
  await recorder.ready;
  const closed = await recorder.stop();
  assert.equal(closed.state, 'closed');
  assert.equal(closeReads, 2, 'a mid-body transport drop is retried, not reported as invalid_response');
} finally {
  globalThis.fetch = originalFetch;
}

// Paced reviewer reproduction (TC-560 follow-up): non-zero backoff, every upload 503s twice
// before succeeding, so retrying ranges hold task slots long enough to fill the 64-slot table.
// Flushes past capacity drop PCM into queued missing rows; stop() drains them as slots free and
// the manifest still closes — no storage_admission fault, no lost evidence.
const pacedLedger = new Map<string, { sequence: number; state: string; path?: string }>();
const pacedAttempts = new Map<number, number>();
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method === 'GET') return Response.json({ version: 1, meeting_id: '1', clock_origin: 'first_admitted_capture_epoch_ms', clock_origin_ms: 0, state: 'open', ranges: [] });
  const form = init?.body as FormData | undefined;
  const range = typeof form?.get('range_metadata') === 'string' ? JSON.parse(form.get('range_metadata') as string) : {};
  if (path.endsWith('/reserve')) {
    pacedLedger.set(range.idempotency_key, { sequence: range.sequence, state: 'sealed', path: `/meetings/1/attributed-audio/ranges/${range.sequence}` });
    return Response.json({ ...range, state: 'sealed', path: `/meetings/1/attributed-audio/ranges/${range.sequence}` });
  }
  if (path.endsWith('/upload')) {
    const attempts = (pacedAttempts.get(range.sequence) ?? 0) + 1;
    pacedAttempts.set(range.sequence, attempts);
    if (attempts <= 2) return new Response('overloaded', { status: 503 });
    pacedLedger.get(range.idempotency_key)!.state = 'uploaded';
    return Response.json({ path: `/meetings/1/attributed-audio/ranges/${range.sequence}` });
  }
  if (path.endsWith('/fail')) {
    pacedLedger.get(range.idempotency_key)!.state = 'failed';
    return Response.json({ ...range, state: 'failed' });
  }
  if (path.endsWith('/close')) return Response.json({ state: 'closed' });
  return Response.json({});
};
try {
  const recorder = createHttpAttributedAudioRecorder({
    platform: 'google_meet', meetingUrl: 'https://meet.test/a', botName: 'Vexa', redisUrl: 'redis://x',
    transcribeEnabled: false, meeting_id: 1, connectionId: 's', attributedAudioUploadUrl: 'https://api.test/internal/attributed-audio/upload',
  }, { retryDelaysMs: [10, 10], warn: () => {} });
  assert.ok(recorder);
  await recorder.ready;
  // A synchronous flush burst: no retrying task can settle mid-loop, so flushes 65+ hit a full
  // task table while every earlier range is still inside its 503 backoff.
  for (let i = 0; i < 90; i++) {
    recorder.feed({ channel: i % 3, speaker_key: `channel:${i % 3}`, speaker_name: '', attribution: { source: 'unresolved', confidence: 0 }, pcm: new Float32Array(1_600), capture_ms: 1_000 + i * 1_000, sample_rate: 16_000 });
  }
  assert.equal(recorder.pendingTasks(), 64, 'the task table is exactly full');
  const pacedManifest = await recorder.stop();
  assert.equal(pacedManifest.state, 'closed');
  const pacedRows = [...pacedLedger.values()].sort((a, b) => a.sequence - b.sequence);
  assert.equal(pacedRows.length, 90, 'every flushed turn reached the ledger');
  assert.deepEqual(pacedRows.map(row => row.sequence), Array.from({ length: 90 }, (_, i) => i), 'no sequence gaps for ptx');
  assert.equal(pacedRows.filter(row => row.state === 'failed').length, 26, 'slot-starved turns are durably failed');
  assert.equal(pacedRows.filter(row => row.state === 'uploaded').length, 64);
  assert.ok([...pacedAttempts.values()].every(count => count === 3), 'every uploaded range used its 503 retries');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('attributed HTTP adapter memory and timeout fence passes');
