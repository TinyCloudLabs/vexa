import assert from 'node:assert/strict';
import { GmeetCompatibleBuffer } from './gmeet-compatible-buffer.js';

const participant = 'TC965_PARTICIPANT_CANARY';
const transcript = 'TC965_TRANSCRIPT_CANARY https://meet.google.com/xxx-xxxx-xxx';
const logs: string[] = [];
const streams = new GmeetCompatibleBuffer({
  logger: (message) => logs.push(message),
  isHallucination: () => true,
  scheduleSubmissions: false,
});
streams.addSpeaker('ch-1:1', participant);
streams.handleTranscriptionResult('ch-1:1', transcript, 1);
streams.removeAll();

const output = logs.join('\n');
assert.ok(output.length > 0, 'filtered transcription emits an INFO log');
assert.ok(!output.includes(participant), 'participant name is absent from INFO logs');
assert.ok(!output.includes(transcript), 'transcript text is absent from INFO logs');
assert.ok(!output.includes('https://meet.google.com/xxx-xxxx-xxx'), 'meeting URL is absent from INFO logs');
