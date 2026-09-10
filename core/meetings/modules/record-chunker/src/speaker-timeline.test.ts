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
timeline.observe(epoch + 250, a, true);
timeline.observe(epoch + 500, b, true);
timeline.observe(epoch + 750, b, true);
timeline.observe(epoch + 1000, [...a, ...b], true);
timeline.observe(epoch + 1250, [...a, ...b], true);
timeline.observe(epoch + 1500, a, false);
const first = timeline.drain(epoch + 1750, true)!;
assert.equal(first.recording_started_at_ms, epoch);
assert.deepEqual(first.intervals.map(i => [i.start_ms, i.end_ms, i.participant_id, i.attribution]), [
  [0, 250, 'participant-a', 'identified'], [250, 500, null, 'unknown'],
  [500, 750, 'participant-b', 'identified'], [750, 1000, null, 'unknown'],
  [1000, 1250, null, 'overlap'], [1250, 1750, null, 'unknown'],
]);
assert.equal(timeline.pendingIntervals, 0);
timeline.observe(epoch + 1750, a, true);
const stale = timeline.drain(epoch + 2750, true)!;
assert.deepEqual(stale.intervals.map(i => [i.start_ms, i.end_ms, i.attribution]), [[1750, 2750, 'unknown']]);

// An upload between polls must not certify the previous speaker over an unseen change.
const between = createSpeakerTimeline();
between.start(epoch);
between.observe(epoch, a, true);
assert.deepEqual(between.drain(epoch + 125)!.intervals, []);
between.observe(epoch + 250, b, true);
between.observe(epoch + 500, b, true);
assert.deepEqual(between.drain(epoch + 550)!.intervals.map(i => [i.start_ms, i.end_ms, i.attribution]), [
  [0, 250, 'unknown'], [250, 500, 'identified'],
]);
assert.deepEqual(between.drain(epoch + 600, true)!.intervals.map(i => [i.start_ms, i.end_ms, i.attribution]), [[500, 600, 'unknown']]);

// An hour without uploads cannot retain meeting-length state. Preserve coverage as unknown
// after the bounded named prefix; a resumed upload starts a fresh bounded batch.
const stalled = createSpeakerTimeline({ maxIntervals: 8 });
stalled.start(epoch);
for (let ms = 0; ms < 3_600_000; ms += 250) {
  stalled.observe(epoch + ms, ms % 1000 < 500 ? a : b, true);
  assert.ok(stalled.pendingIntervals <= 8);
}
const capped = stalled.drain(epoch + 3_600_000, true)!;
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
assert.equal(ambiguous.drain(epoch + 100, true)?.intervals[0]?.attribution, 'unknown');
console.log('speaker timeline: clock, distinct identities, overlap, missing audio, expiry and hour-long bounded state passed');
