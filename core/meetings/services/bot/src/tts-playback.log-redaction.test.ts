import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createTtsPlayback } from './tts-playback.js';

async function main(): Promise<void> {
  const transcript = 'TC965_TRANSCRIPT_CANARY';
  const url = 'https://meet.google.com/xxx-xxxx-xxx';
  const server = createServer((_request, response) => {
    response.statusCode = 400;
    response.end(`${transcript} ${url}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previousServiceUrl = process.env.TTS_SERVICE_URL;
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${address.port}`;
  const logs: string[] = [];
  try {
    await createTtsPlayback((message) => logs.push(message)).speak(`${transcript} ${url}`);
  } finally {
    if (previousServiceUrl === undefined) delete process.env.TTS_SERVICE_URL;
    else process.env.TTS_SERVICE_URL = previousServiceUrl;
    const closed = once(server, 'close');
    server.close();
    await closed;
  }

  const output = logs.join('\n');
  assert.ok(output.includes('status 400'), 'failed TTS request emits an INFO log');
  assert.ok(!output.includes(transcript), 'transcript text is absent from INFO logs');
  assert.ok(!output.includes(url), 'meeting URL is absent from INFO logs');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
