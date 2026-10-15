import assert from 'node:assert/strict';
import { SpeakerStreamManager } from './speaker-streams.js';
import { setLogger } from './log.js';

const participant = 'TC965_PARTICIPANT_CANARY';
const url = 'https://meet.google.com/xxx-xxxx-xxx';
const phrase = `redaction canary text ${url}`;
const logs: string[] = [];
setLogger((message) => logs.push(message));

const streams = new SpeakerStreamManager();
streams.addSpeaker('ch-1:1', participant);
streams.handleTranscriptionResult('ch-1:1', `${phrase} ${phrase} ${phrase}`, 1);
streams.removeAll();

const output = logs.join('\n');
assert.ok(output.length > 0, 'the filtered transcription path emits an INFO log');
assert.ok(!output.includes(participant), 'participant name is absent from INFO logs');
assert.ok(!output.includes(phrase), 'transcript text is absent from INFO logs');
assert.ok(!output.includes(url), 'meeting URL is absent from INFO logs');
