import type { Page } from 'playwright';
import { joinJitsiMeeting } from './join';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const participant = 'TC965_PARTICIPANT_CANARY';
  const url = 'https://meet.google.com/xxx-xxxx-xxx';
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(' '));
  try {
    const page = {
      on() {},
      async goto() { throw new Error('stop after navigation log'); },
    } as unknown as Page;
    await joinJitsiMeeting(page, url, participant, {} as Parameters<typeof joinJitsiMeeting>[3]);
  } catch {
    // The fake navigation stops immediately after the production log statement.
  } finally {
    console.log = originalLog;
  }

  const output = logs.join('\n');
  check(output.length > 0, 'Jitsi navigation emits an INFO log');
  check(!output.includes(participant), 'participant name is absent from INFO logs');
  check(!output.includes(url), 'meeting URL and native code are absent from INFO logs');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
