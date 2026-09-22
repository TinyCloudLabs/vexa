/** HTTP adapter for canonical GMeet attributed PCM. */
import { createAttributedAudioRecorder, type AttributedAudioManifest, type AttributedAudioStore } from '@vexa/gmeet-pipeline';
import type { Invocation } from './config.js';

export const ATTRIBUTED_AUDIO_HTTP_TIMEOUT_MS = 15_000;
// Multipart construction owns another copy of a PCM buffer and fetch may retain a body copy until
// the request settles. Reserve all three owners before admission, not merely the recorder queue.
export const ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES = Math.floor((32 * 1024 * 1024) / 3);

/** The PCM boundary never exposes transport bodies or exception text: they may contain PCM,
 * object keys, credentials, or provider paths. */
class AttributedAudioRequestError extends Error {
  constructor(stage: string, code: 'network' | 'invalid_response' | 'http', status?: number) {
    super(`attributed-audio ${stage} failed (code ${code}${status === undefined ? '' : ` status ${status}`})`);
    this.name = 'AttributedAudioRequestError';
  }
}

export function createHttpAttributedAudioRecorder(inv: Invocation, options: { requestTimeoutMs?: number } = {}) {
  const upload = inv.attributedAudioUploadUrl;
  if (!upload || !inv.connectionId) return undefined;
  const endpoint = (name: 'reserve' | 'upload' | 'fail' | 'close' | 'manifest') => upload.replace(/\/upload$/, `/${name}`);
  const request = async (stage: string, url: string, method: 'GET' | 'POST', form?: FormData) => {
    let response: Response;
    try {
      response = await fetch(url, { method, body: form, signal: AbortSignal.timeout(options.requestTimeoutMs ?? ATTRIBUTED_AUDIO_HTTP_TIMEOUT_MS), headers: { Authorization: `Bearer ${inv.internalSecret ?? inv.token ?? ''}` } });
    } catch {
      throw new AttributedAudioRequestError(stage, 'network');
    }
    if (!response.ok) throw new AttributedAudioRequestError(stage, 'http', response.status);
    try {
      return await response.json() as Record<string, unknown>;
    } catch {
      throw new AttributedAudioRequestError(stage, 'invalid_response');
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
