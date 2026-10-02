/** HTTP adapter for canonical GMeet attributed PCM. */
import { setTimeout as sleep } from 'node:timers/promises';
import { createAttributedAudioRecorder, type AttributedAudioManifest, type AttributedAudioStore } from '@vexa/gmeet-pipeline';
import type { Invocation } from './config.js';

export const ATTRIBUTED_AUDIO_HTTP_TIMEOUT_MS = 15_000;
/** Bounded backoff for transient request failures. Idempotency keys make the retry safe: the
 * meeting-api ledger replays a same-key reserve, acknowledges a duplicate upload as a receipt
 * only, re-marks a failed range without regressing uploaded, and re-answers a closed manifest. */
export const ATTRIBUTED_AUDIO_HTTP_RETRY_DELAYS_MS = [250, 1_000, 4_000];
// Multipart construction owns another copy of a PCM buffer and fetch may retain a body copy until
// the request settles. Reserve all three owners before admission, not merely the recorder queue.
export const ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES = Math.floor((32 * 1024 * 1024) / 3);

/** The PCM boundary never exposes transport bodies or exception text: they may contain PCM,
 * object keys, credentials, or provider paths. */
class AttributedAudioRequestError extends Error {
  readonly stage: string;
  readonly code: 'network' | 'invalid_response' | 'http';
  readonly status?: number;
  constructor(stage: string, code: 'network' | 'invalid_response' | 'http', status?: number) {
    super(`attributed-audio ${stage} failed (code ${code}${status === undefined ? '' : ` status ${status}`})`);
    this.name = 'AttributedAudioRequestError';
    this.stage = stage; this.code = code; this.status = status;
  }
}

export function createHttpAttributedAudioRecorder(inv: Invocation, options: { requestTimeoutMs?: number; retryDelaysMs?: readonly number[]; warn?: (message: string) => void } = {}) {
  const upload = inv.attributedAudioUploadUrl;
  if (!upload || !inv.connectionId) return undefined;
  const retryDelays = options.retryDelaysMs ?? ATTRIBUTED_AUDIO_HTTP_RETRY_DELAYS_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  // One line per distinct failure signature: a transient faulted range resolves as durable
  // 'failed' and capture continues, so per-attempt spam would only repeat the same stage/code.
  const reported = new Set<string>();
  const reportOnce = (error: unknown) => {
    const message = String(error);
    if (reported.has(message)) return;
    reported.add(message);
    warn(`[bot] attributed-audio request: ${message}`);
  };
  const endpoint = (name: 'reserve' | 'upload' | 'fail' | 'close' | 'manifest') => upload.replace(/\/upload$/, `/${name}`);
  const request = async (stage: string, url: string, method: 'GET' | 'POST', form?: FormData) => {
    const timeoutMs = options.requestTimeoutMs ?? ATTRIBUTED_AUDIO_HTTP_TIMEOUT_MS;
    // Only outcomes the server might not have observed are replayed: a dropped connection or
    // timeout ('network'), a rate limit (429), and server faults (5xx). A 4xx such as the
    // idempotency/metadata 409 is deterministic and fails immediately.
    const retryable = (error: AttributedAudioRequestError) =>
      error.code === 'network' || error.status === 429 || (error.status !== undefined && error.status >= 500);
  /** Per-attempt delay: full jitter on the configured bound with no hint; a Retry-After header
   * is a minimum wait honored up to the bound, with jitter spread between the two so the retry
   * never fires inside the server's advertised cooldown. */
  const delayFor = (attempt: number, response?: Response): number => {
    const bound = retryDelays[attempt];
    const header = response?.headers.get('retry-after');
    const hinted = header === null || header === undefined ? NaN
      : /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1_000
      : Date.parse(header) - Date.now();
    return Number.isFinite(hinted) && hinted >= 0
      ? Math.min(hinted, bound) + Math.random() * Math.max(0, bound - Math.min(hinted, bound))
      : bound * Math.random();
  };
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { method, body: form, signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${inv.internalSecret ?? inv.token ?? ''}` } });
      } catch {
        const error = new AttributedAudioRequestError(stage, 'network');
        reportOnce(error);
        if (attempt >= retryDelays.length || !retryable(error)) throw error;
        await sleep(delayFor(attempt));
        continue;
      }
      if (!response.ok) {
        const error = new AttributedAudioRequestError(stage, 'http', response.status);
        reportOnce(error);
        if (attempt >= retryDelays.length || !retryable(error)) throw error;
        await sleep(delayFor(attempt, response));
        continue;
      }
      try {
        // Read the body first: a 2xx means the server already committed the request, and a mid-body
        // network drop loses only our view of the acknowledgement — the idempotency key makes the
        // retry replay-safe, while malformed JSON after a complete body is a real protocol break.
        const body = await response.text();
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch {
          const error = new AttributedAudioRequestError(stage, 'invalid_response');
          reportOnce(error);
          throw error;
        }
      } catch (error) {
        if (error instanceof AttributedAudioRequestError) throw error;
        const transport = new AttributedAudioRequestError(stage, 'network');
        reportOnce(transport);
        if (attempt >= retryDelays.length) throw transport;
        await sleep(delayFor(attempt));
      }
    }
  };
  const metadata = (range: object) => { const form = new FormData(); form.set('session_uid', inv.connectionId!); form.set('range_metadata', JSON.stringify(range)); return form; };
  const store: AttributedAudioStore = {
    load: async () => request('manifest', `${endpoint('manifest')}?session_uid=${encodeURIComponent(inv.connectionId!)}`, 'GET') as unknown as Promise<AttributedAudioManifest>,
    reserve: async range => request('reserve', endpoint('reserve'), 'POST', metadata(range)) as Promise<any>,
    upload: async (range, pcm) => {
      const form = metadata(range);
      form.set('file', new Blob([...pcm], { type: 'application/octet-stream' }), 'range.pcm');
      const receipt = await request('upload', endpoint('upload'), 'POST', form);
      if (typeof receipt.path !== 'string') throw new AttributedAudioRequestError('upload', 'invalid_response');
      return { path: receipt.path };
    },
    fail: async range => request('fail', endpoint('fail'), 'POST', metadata(range)) as Promise<any>,
    close: async () => { const form = new FormData(); form.set('session_uid', inv.connectionId!); await request('close', endpoint('close'), 'POST', form); },
  };
  return createAttributedAudioRecorder(String(inv.meeting_id ?? ''), store, { budgetBytes: ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES });
}
