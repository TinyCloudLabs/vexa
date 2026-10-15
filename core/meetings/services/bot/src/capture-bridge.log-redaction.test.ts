import assert from 'node:assert/strict';
import { makeSpeakerHintSink, makeTeamsCaptionSink } from './capture-bridge.js';

const participant = 'TC965_PARTICIPANT_CANARY';
const transcript = 'TC965_TRANSCRIPT_CANARY';
const url = 'https://meet.google.com/xxx-xxxx-xxx';
const logs: string[] = [];
const hint = makeSpeakerHintSink(
  { recordHint() {} },
  (message) => logs.push(message),
);
hint.sink(participant, 1);
const sink = makeTeamsCaptionSink(
  undefined,
  (message) => logs.push(message),
  (message) => logs.push(message),
).sink;
sink(participant, `${transcript} ${url}`, 1, true);

const output = logs.join('\n');
assert.equal(logs.length, 3, 'caption and stale-hint paths emit logs');
assert.ok(!output.includes(participant), 'participant name is absent from INFO and warning logs');
assert.ok(!output.includes(transcript), 'caption text is absent from INFO and warning logs');
assert.ok(!output.includes(url), 'meeting URL is absent from INFO and warning logs');
