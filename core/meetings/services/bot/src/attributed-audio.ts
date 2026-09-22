/** HTTP store adapter for canonical GMeet attributed PCM. It is independent of STT. */
import { createAttributedAudioRecorder, type AttributedAudioStore } from '@vexa/gmeet-pipeline';
import type { Invocation } from './config.js';

export function createHttpAttributedAudioRecorder(inv: Invocation) {
  const upload = inv.attributedAudioUploadUrl;
  if (!upload || !inv.connectionId) return undefined;
  const request = async (url: string, form: FormData) => {
    const response = await fetch(url, {
      method: 'POST', body: form,
      headers: { Authorization: `Bearer ${inv.internalSecret ?? inv.token ?? ''}` },
    });
    if (!response.ok) throw new Error(`attributed-audio request failed (${response.status}): ${await response.text()}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const store: AttributedAudioStore = {
    // Each HTTP write itself durably records sealed/uploaded/failed state server-side.
    save: async () => {},
    put: async (range, pcm) => {
      const form = new FormData();
      form.set('session_uid', inv.connectionId!);
      form.set('range_metadata', JSON.stringify(range));
      form.set('file', new Blob([pcm], { type: 'application/octet-stream' }), 'range.pcm');
      const receipt = await request(upload, form);
      if (typeof receipt.path !== 'string') throw new Error('attributed-audio receipt omitted retrieval path');
      return { path: receipt.path };
    },
    close: async () => {
      const form = new FormData(); form.set('session_uid', inv.connectionId!);
      await request(upload.replace(/\/upload$/, '/close'), form);
    },
  };
  return createAttributedAudioRecorder(String(inv.meeting_id ?? ''), store);
}
