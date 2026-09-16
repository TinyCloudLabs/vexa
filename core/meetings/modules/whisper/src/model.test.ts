/**
 * P5 gate (the #522 fixture the STT seam lacked): the request the wire actually sees carries the
 * DEPLOYMENT'S model id — a validating OpenAI-compatible backend (Groq, vLLM, LiteLLM) rejects a
 * wrong `model` form part with 404 model_not_found, so the adapter must send the configured id and
 * default to `whisper-1` byte-for-byte when none is configured. Stubs global fetch and inspects
 * the multipart body ("validating backend" edge — D-A2).
 * Run: npm test (chained)  or  npx tsx src/model.test.ts
 */
import { TranscriptionClient } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const realFetch = globalThis.fetch;
/** Replace global fetch with a 200 stub that CAPTURES the multipart body. */
function captureFetch(): () => string {
  let body = '';
  (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
    body = Buffer.from(init.body).toString('latin1');
    return new Response(JSON.stringify({ text: 'ok', language: 'en', duration: 0.1, segments: [] }), { status: 200 });
  };
  return () => body;
}
/** The value of the `model` form part in a captured multipart body (null if absent). */
function modelPartOf(body: string): string | null {
  const m = body.match(/name="model"\r\n\r\n([^\r]*)\r\n/);
  return m ? m[1] : null;
}
/** The value of the `response_format` form part in a captured multipart body. */
function responseFormatPartOf(body: string): string | null {
  const m = body.match(/name="response_format"\r\n\r\n([^\r]*)\r\n/);
  return m ? m[1] : null;
}

async function run() {
  const pcm = new Float32Array(1600).fill(0.05); // 0.1s of audio

  // Configured model → the wire carries exactly that id.
  {
    const body = captureFetch();
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'whisper-large-v3-turbo' });
    await client.transcribe(pcm, 'en');
    check('configured model rides the model form part', modelPartOf(body()) === 'whisper-large-v3-turbo', `got ${JSON.stringify(modelPartOf(body()))}`);
  }
  // No model configured → today's wire, byte-for-byte: whisper-1.
  {
    const body = captureFetch();
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test' });
    await client.transcribe(pcm, 'en');
    check('unconfigured → default whisper-1 (no behavior change)', modelPartOf(body()) === 'whisper-1', `got ${JSON.stringify(modelPartOf(body()))}`);
  }
  // Backends such as Voxtral reject verbose_json but accept the same OpenAI endpoint with json.
  {
    const formats: Array<string | null> = [];
    (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
      formats.push(responseFormatPartOf(Buffer.from(init.body).toString('latin1')));
      if (formats.length === 1) {
        return new Response(JSON.stringify({ message: 'Currently do not support verbose_json for Voxtral' }), { status: 400 });
      }
      return new Response(JSON.stringify({ text: 'voxtral ok' }), { status: 200 });
    };
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'voxtral', maxRetries: 0 });
    const first = await client.transcribe(pcm, 'en');
    await client.transcribe(pcm, 'en');
    check('verbose_json rejection falls back once, then caches json',
      JSON.stringify(formats) === JSON.stringify(['verbose_json', 'json', 'json']),
      `formats=${JSON.stringify(formats)}`);
    check('json-only response remains a valid transcription result', first.text === 'voxtral ok', `text=${JSON.stringify(first.text)}`);
  }
  // Tinfoil uses the same OpenAI transcription shape. This is a request-shape contract only:
  // it does not contact a tenant account or claim a live meeting result.
  {
    let request: { url?: unknown; headers?: Record<string, string>; body?: string } = {};
    (globalThis as any).fetch = async (url: unknown, init: { headers: Record<string, string>; body: Buffer }) => {
      request = { url, headers: init.headers, body: Buffer.from(init.body).toString('latin1') };
      return new Response(JSON.stringify({ text: 'private meeting text' }), { status: 200 });
    };
    const result = await new TranscriptionClient({
      serviceUrl: 'https://inference.tinfoil.sh',
      apiToken: 'test-tinfoil-token',
      model: 'voxtral-small-24b',
      maxRetries: 0,
    }).transcribe(pcm, 'en', 'quarterly planning');
    check('Tinfoil: exact OpenAI transcription URL', request.url === 'https://inference.tinfoil.sh/v1/audio/transcriptions', String(request.url));
    check('Tinfoil: bearer token and Voxtral model reach the wire',
      request.headers?.Authorization === 'Bearer test-tinfoil-token' && modelPartOf(request.body ?? '') === 'voxtral-small-24b');
    check('Tinfoil: PCM WAV, language, and prompt reach the wire',
      /name="file"; filename="audio.wav"/.test(request.body ?? '')
      && /name="language"\r\n\r\nen\r\n/.test(request.body ?? '')
      && /name="prompt"\r\n\r\nquarterly planning\r\n/.test(request.body ?? ''));
    check('Tinfoil: text-only response is accepted without changing timing metadata',
      result.text === 'private meeting text' && result.segments.length === 0 && result.duration === 0);
  }

  (globalThis as any).fetch = realFetch;
  if (failed) { console.error(`\n❌ stt model: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ stt model (P5, #522): configured model ids reach the wire; json-only OpenAI-compatible backends negotiate once.');
}
run().catch((e) => { console.error(e); process.exit(1); });
