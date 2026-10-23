// Admission-blocked reporter: rate limit per reason, counting, and payload shape. Injected clock; no timers.
import {
  ADMISSION_BLOCKED_LOG_INTERVAL_MS,
  createAdmissionBlockedReporter,
  type AdmissionBlockedEvent,
} from "./admission-blocked";

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function harness() {
  let now = 1_000;
  const emitted: AdmissionBlockedEvent[] = [];
  const reporter = createAdmissionBlockedReporter({
    now: () => now,
    emit: (event) => emitted.push(event),
  });
  return {
    reporter,
    emitted,
    at(ms: number) {
      now = ms;
    },
  };
}

// first suppression of a reason emits at once, with the enum-only payload
{
  const h = harness();
  h.reporter.suppressed("modal_dialog");
  check("first suppression emits once", h.emitted.length === 1, `got ${h.emitted.length}`);
  check(
    "first payload is the documented shape",
    JSON.stringify(h.emitted[0]) ===
      JSON.stringify({ event: "admission.blocked", platform: "google_meet", reason: "modal_dialog", count: 1, ts_ms: 1_000 }),
    JSON.stringify(h.emitted[0]),
  );
}

// payload carries only the documented keys
{
  const h = harness();
  h.reporter.suppressed("consent_text");
  const keys = Object.keys(h.emitted[0]).sort().join(",");
  check("payload keys are exactly count,event,platform,reason,ts_ms", keys === "count,event,platform,reason,ts_ms", keys);
}

// repeats inside the interval are suppressed and counted; the next emission reports the total
{
  const h = harness();
  h.reporter.suppressed("notes_text");
  h.at(1_000 + 10_000);
  h.reporter.suppressed("notes_text");
  h.at(1_000 + 20_000);
  h.reporter.suppressed("notes_text");
  check("no emission inside the interval", h.emitted.length === 1, `got ${h.emitted.length}`);
  h.at(1_000 + ADMISSION_BLOCKED_LOG_INTERVAL_MS);
  h.reporter.suppressed("notes_text");
  check("emits again at the interval boundary", h.emitted.length === 2, `got ${h.emitted.length}`);
  check("count covers suppressions since last emit, including this one", h.emitted[1]?.count === 3, `got ${h.emitted[1]?.count}`);
  check("ts_ms is the emitting call time", h.emitted[1]?.ts_ms === 1_000 + ADMISSION_BLOCKED_LOG_INTERVAL_MS, `got ${h.emitted[1]?.ts_ms}`);
}

// the count resets after each emission
{
  const h = harness();
  h.reporter.suppressed("waiting_room_indicator");
  h.at(1_000 + ADMISSION_BLOCKED_LOG_INTERVAL_MS);
  h.reporter.suppressed("waiting_room_indicator");
  h.at(1_000 + 2 * ADMISSION_BLOCKED_LOG_INTERVAL_MS);
  h.reporter.suppressed("waiting_room_indicator");
  const counts = h.emitted.map((e) => e.count).join(",");
  check("count resets after each emission", counts === "1,1,1", counts);
}

// reasons are rate-limited independently
{
  const h = harness();
  h.reporter.suppressed("modal_dialog");
  h.reporter.suppressed("no_positive_evidence");
  const reasons = h.emitted.map((e) => e.reason).join(",");
  check("reasons are rate-limited independently", reasons === "modal_dialog,no_positive_evidence", reasons);
}

// one millisecond short of the interval stays suppressed; the interval itself emits
{
  const h = harness();
  h.reporter.suppressed("consent_text");
  h.at(1_000 + ADMISSION_BLOCKED_LOG_INTERVAL_MS - 1);
  h.reporter.suppressed("consent_text");
  check("29,999 ms after the last emit stays suppressed", h.emitted.length === 1, `got ${h.emitted.length}`);
  h.at(1_000 + ADMISSION_BLOCKED_LOG_INTERVAL_MS);
  h.reporter.suppressed("consent_text");
  check("30,000 ms after the last emit emits", h.emitted.length === 2, `got ${h.emitted.length}`);
}

if (failed > 0) {
  console.log(`admission-blocked.test.ts: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("admission-blocked.test.ts: all checks passed");
