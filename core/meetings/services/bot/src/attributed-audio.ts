/** HTTP adapter for canonical GMeet attributed PCM. */
import { createAttributedAudioRecorder, type AttributedAudioManifest, type AttributedAudioStore } from '@vexa/gmeet-pipeline';
import type { Invocation } from './config.js';

export const ATTRIBUTED_AUDIO_HTTP_TIMEOUT_MS = 15_000;
// Multipart construction owns another copy of a PCM buffer and fetch may retain a body copy until
// the request settles. Reserve all three owners before admission, not merely the recorder queue.
export const ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES = Math.floor((32 * 1024 * 1024) / 3);

export function createHttpAttributedAudioRecorder(inv: Invocation, options: { requestTimeoutMs?: number } = {}) {
  const upload = inv.attributedAudioUploadUrl;
  if (!upload || !inv.connectionId) return undefined;
  const endpoint = (name: 'reserve' | 'upload' | 'fail' | 'close' | 'manifest') => upload.replace(/\/upload$/, `/${name}`);
  const request = async (stage: string, url: string, method: 'GET' | 'POST', form?: FormData) => {
    const response = await fetch(url, { method, body: form, signal: AbortSignal.timeout(options.requestTimeoutMs ?? ATTRIBUTED_AUDIO_HTTP_TIMEOUT_MS), headers: { Authorization: `Bearer ${inv.internalSecret ?? inv.token ?? ''}` } });
    if (!response.ok) throw new Error(`attributed-audio ${stage} failed (status ${response.status})`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const metadata = (range: object) => { const form = new FormData(); form.set('session_uid', inv.connectionId!); form.set('range_metadata', JSON.stringify(range)); return form; };
  const store: AttributedAudioStore = {
    load: async () => request('manifest', `${endpoint('manifest')}?session_uid=${encodeURIComponent(inv.connectionId!)}`, 'GET') as unknown as Promise<AttributedAudioManifest>,
    reserve: async range => request('reserve', endpoint('reserve'), 'POST', metadata(range)) as Promise<any>,
    upload: async (range, pcm) => {
      const form = metadata(range);
      form.set('file', new Blob([...pcm], { type: 'application/octet-stream' }), 'range.pcm');
      const receipt = await request('upload', endpoint('upload'), 'POST', form);
      if (typeof receipt.path !== 'string') throw new Error('attributed-audio receipt omitted retrieval path');
      return { path: receipt.path };
    },
    fail: async range => request('fail', endpoint('fail'), 'POST', metadata(range)) as Promise<any>,
    close: async manifest => { const form = new FormData(); form.set('session_uid', inv.connectionId!); form.set('admitted_sequences', JSON.stringify(manifest.ranges.map(range => range.sequence))); await request('close', endpoint('close'), 'POST', form); },
  };
  return createAttributedAudioRecorder(String(inv.meeting_id ?? ''), store, { budgetBytes: ATTRIBUTED_AUDIO_HTTP_PCM_BUDGET_BYTES });
}
