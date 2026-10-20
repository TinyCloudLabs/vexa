import { createHash } from 'node:crypto';

const EVENTS: Record<string, true> = {
  'capture_signal.tape_started': true, 'capture_signal.tape_capped': true,
  'capture_signal.tape_uploaded': true, 'capture_signal.tape_upload_failed': true,
  'capture_signal.tape_upload_skipped': true, 'capture_signal.cap_invalid': true,
  transcription_retry: true, transcription_failed: true, transcript_publish_drain_timeout: true,
  'join.lobby_locale': true, 'join.selector_miss': true, 'join.name_entry': true, 'join.gemini_notice_handled': true,
  'admission.waiting': true, 'admission.admitted': true, 'admission.rejected': true,
  'leave.completed': true, 'leave.failed': true, 'removal.detected': true, 'removal.monitor_stopped': true,
  'process.fatal': true,
};
const ENUMS: Record<string, true> = {
  payment_required: true, unauthorized: true, rate_limited: true, unavailable: true,
  timeout: true, bad_request: true, unknown: true, google_meet: true, teams: true, zoom: true,
  jitsi: true, 'captured-signal': true, stt: true, captions: true, csrc: true,
  observations: true, botlog: true, transcript: true,
  uncaught_exception: true, unhandled_rejection: true,
};
const NUMBERS: Record<string, true> = {
  attempt: true, attempts: true, attempts_max: true, max_retries: true, retry_delay_ms: true,
  http_status: true, status: true, pcm_len: true, prompt_len: true, duration: true,
  duration_seconds: true, chunk_seq: true, is_final: true, bytes: true, byte_length: true,
  frames: true, frame_count: true, segment_count: true, dropped_bytes: true, elapsed_ms: true,
  max_bytes: true, max_tape_bytes: true, file_size_bytes: true, chunk_size_bytes: true,
  sample_rate: true, channels: true, timeout_ms: true, pending_count: true, selector_count: true,
  candidate_count: true, participant_tiles: true, self_name_count: true, real_tiles: true, recaptcha_frames: true,
};
const BOOLEANS: Record<string, true> = {
  ok: true, success: true, confirmed: true, leave_result: true, truncated: true, capped: true,
  admitted: true, removed: true, name_entered: true, waiting_room: true,
};
const LEVELS: Record<string, true> = { trace: true, debug: true, info: true, warn: true, error: true, fatal: true };
const ERROR_CODES: Record<string, true> = {
  operation_failed: true, upload_failed: true, chunk_handler_failed: true,
  missing_config: true,
  anti_bot_wall: true, admission_denied: true, lobby_timeout: true,
  host_denial: true, captcha_pending: true, captcha_unsolved: true, error_page: true,
};

function safeRecord(value: unknown): Record<string, unknown> | null {
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(source)) {
    if (key === 'meeting_id' && typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) {
      result.meeting_id = createHash('sha256').update(String(field)).digest('hex').slice(0, 16);
    } else if (key === 'level' && typeof field === 'string' && Object.hasOwn(LEVELS, field)) {
      result.level = field;
    } else if (key === 'event' && typeof field === 'string' && Object.hasOwn(EVENTS, field)) {
      result.event = field;
    } else if ((key === 'html_lang' || key === 'navigator_language') && typeof field === 'string' &&
      (field === 'unknown' || /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(field))) {
      result[key] = field;
    } else if ((key === 'kind' || key === 'platform' || key === 'part') && typeof field === 'string' && Object.hasOwn(ENUMS, field)) {
      result[key] = field;
    } else if (key === 'error_code' && typeof field === 'string' && Object.hasOwn(ERROR_CODES, field)) {
      result.error_code = field;
    } else if (Object.hasOwn(NUMBERS, key) && typeof field === 'number' && Number.isFinite(field)) {
      result[key] = field;
    } else if (Object.hasOwn(BOOLEANS, key) && typeof field === 'boolean') {
      result[key] = field;
    }
  }
  return Object.keys(result).length ? result : null;
}

export function sanitizeLogText(text: string): string {
  try {
    const record = safeRecord(JSON.parse(text));
    return record ? JSON.stringify(record) : '';
  } catch {
    return '';
  }
}

export function installProcessLogSanitizer(): void {
  const state = globalThis as typeof globalThis & { __vexaProcessLogSanitizer?: boolean };
  if (state.__vexaProcessLogSanitizer) return;
  state.__vexaProcessLogSanitizer = true;

  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[method] = ((...args: unknown[]) => {
      let text = '';
      try {
        text = args.length === 1 && typeof args[0] === 'string'
          ? args[0]
          : args.length === 1 && args[0] && typeof args[0] === 'object'
            ? JSON.stringify(args[0]) ?? ''
            : '';
      } catch {
        return;
      }
      const safe = sanitizeLogText(text);
      if (!safe) return;
      const output = (method === 'warn' || method === 'error' ? process.stderr : process.stdout) as typeof process.stdout & {
        __vexaOriginalWrite?: typeof process.stdout.write;
      };
      output.__vexaOriginalWrite?.(`${safe}\n`);
    }) as typeof console[typeof method];
  }

  // Less common console APIs still render arbitrary values (or stack frames) directly.
  // Suppress them rather than letting a label or inspection bypass the allowlist.
  for (const method of [
    'trace', 'dir', 'dirxml', 'table', 'assert', 'group', 'groupCollapsed', 'groupEnd',
    'count', 'countReset', 'time', 'timeLog', 'timeEnd', 'clear', 'profile', 'profileEnd', 'timeStamp',
  ]) {
    (console as unknown as Record<string, unknown>)[method] = () => {};
  }

  for (const stream of [process.stdout, process.stderr]) {
    const output = stream as typeof stream & { __vexaOriginalWrite?: typeof stream.write };
    if (output.__vexaOriginalWrite) continue;
    const original = stream.write.bind(stream);
    output.__vexaOriginalWrite = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding);
      const safe = sanitizeLogText(text);
      if (!safe) {
        done?.();
        return true;
      }
      return original(`${safe}\n`, done);
    }) as typeof stream.write;
  }
}

