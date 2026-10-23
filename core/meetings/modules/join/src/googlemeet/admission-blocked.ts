/**
 * Admission-guard suppression reporting.
 *
 * When a guard withholds the "admitted" verdict, it reports one enumerated reason as
 * `admission.blocked`. Emission is rate-limited per reason to ADMISSION_BLOCKED_LOG_INTERVAL_MS.
 * The payload is the reason, the number of suppressions since the previous emission for that
 * reason, and a timestamp. It carries no page content.
 */

export const ADMISSION_BLOCK_REASONS = [
  "modal_dialog",
  "consent_text",
  "notes_text",
  "waiting_room_indicator",
  "no_positive_evidence",
] as const;

export type AdmissionBlockReason = (typeof ADMISSION_BLOCK_REASONS)[number];

export const ADMISSION_BLOCKED_LOG_INTERVAL_MS = 30_000;

export interface AdmissionBlockedEvent {
  event: "admission.blocked";
  platform: "google_meet";
  reason: AdmissionBlockReason;
  count: number;
  ts_ms: number;
}

export interface AdmissionBlockedReporter {
  suppressed(reason: AdmissionBlockReason): void;
}

export function createAdmissionBlockedReporter(opts: {
  now: () => number;
  emit: (event: AdmissionBlockedEvent) => void;
  intervalMs?: number;
}): AdmissionBlockedReporter {
  const intervalMs = opts.intervalMs ?? ADMISSION_BLOCKED_LOG_INTERVAL_MS;
  const counts = new Map<AdmissionBlockReason, number>();
  const lastEmittedAt = new Map<AdmissionBlockReason, number>();
  return {
    suppressed(reason) {
      const count = (counts.get(reason) ?? 0) + 1;
      counts.set(reason, count);
      const now = opts.now();
      const last = lastEmittedAt.get(reason);
      if (last !== undefined && now - last < intervalMs) return;
      lastEmittedAt.set(reason, now);
      counts.set(reason, 0);
      opts.emit({ event: "admission.blocked", platform: "google_meet", reason, count, ts_ms: now });
    },
  };
}
