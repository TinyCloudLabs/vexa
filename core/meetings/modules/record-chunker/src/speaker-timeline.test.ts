import assert from 'node:assert/strict';
import { createSpeakerTimeline } from './speaker-timeline.js';

const epoch = 1_800_000_000_000;
const a = [{ id: 'participant-a', name: 'Sam' }];
const b = [{ id: 'participant-b', name: 'Sam' }];
const timeline = createSpeakerTimeline({ staleMs: 500 });
timeline.observe(epoch - 100, a, true); // admission is not the recording clock
assert.equal(timeline.drain(epoch), undefined);
timeline.start(epoch);
timeline.observe(epoch, a, true);
timeline.observe(epoch + 250, b, true);
timeline.observe(epoch + 500, [...a, ...b], true);
timeline.observe(epoch + 750, a, false);
const first = timeline.drain(epoch + 1000)!;
assert.equal(first.recording_started_at_ms, epoch);
assert.deepEqual(first.intervals.map(i => [i.start_ms, i.end_ms, i.participant_id, i.attribution]), [
  [0, 250, 'participant-a', 'identified'], [250, 500, 'participant-b', 'identified'],
  [500, 750, null, 'overlap'], [750, 1000, null, 'unknown'],
]);
assert.equal(timeline.pendingIntervals, 0);
timeline.observe(epoch + 1000, a, true);
const stale = timeline.drain(epoch + 2000)!;
assert.deepEqual(stale.intervals.map(i => [i.start_ms, i.end_ms, i.attribution]), [
  [1000, 1500, 'identified'], [1500, 2000, 'unknown'],
]);

// An hour without uploads cannot retain meeting-length state. Preserve coverage as unknown
// after the bounded named prefix; a resumed upload starts a fresh bounded batch.
const stalled = createSpeakerTimeline({ maxIntervals: 8 });
stalled.start(epoch);
for (let ms = 0; ms < 3_600_000; ms += 250) {
  stalled.observe(epoch + ms, ms % 500 ? a : b, true);
  assert.ok(stalled.pendingIntervals <= 8);
}
const capped = stalled.drain(epoch + 3_600_000)!;
assert.equal(capped.capped, true);
assert.equal(capped.intervals.length, 8);
assert.equal(capped.intervals.at(-1)?.attribution, 'unknown');
assert.equal(capped.intervals.reduce((n, i) => n + i.end_ms - i.start_ms, 0), 3_600_000);
assert.ok(JSON.stringify(capped).length < 2000);
stalled.observe(epoch + 3_600_000, a, true);
assert.equal(stalled.drain(epoch + 3_600_250)?.capped, false);

const ambiguous = createSpeakerTimeline();
ambiguous.start(epoch);
ambiguous.observe(epoch, [...a, { id: a[0]!.id, name: 'Different' }], true);
assert.equal(ambiguous.drain(epoch + 100)?.intervals[0]?.attribution, 'unknown');
console.log('speaker timeline: clock, distinct identities, overlap, missing audio, expiry and hour-long bounded state passed');
