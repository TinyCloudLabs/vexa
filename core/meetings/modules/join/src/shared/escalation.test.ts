// Escalation is one-shot only once the host accepts it. A refused or failed callback leaves the flag unset
// so the next check retries; a trigger while one is in flight does not send a second request.
import { resetEscalation, triggerEscalation, wasEscalationTriggered } from './escalation';
import { setHooks, type JoinState } from '../_host';

// Without DISPLAY, startVncStack returns before spawning anything, so these checks never touch VNC.
delete process.env.DISPLAY;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` - ${detail}`}`);
  if (!ok) failures += 1;
}

type Answer = boolean | undefined | Promise<boolean | undefined>;
let calls = 0;
let respond: () => Answer = () => true;

setHooks({
  onState: (state: JoinState): Answer => {
    if (state !== 'needs_human_help') return undefined;
    calls += 1;
    return respond();
  },
});

// A run that never settles must fail, not exit 0 with the event loop empty.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('escalation tests: did not complete');
    process.exit(1);
  }
});

async function main(): Promise<void> {
  resetEscalation();
  calls = 0;
  respond = () => true;
  await triggerEscalation({}, 'accepted');
  check('accepted escalation sets the one-shot flag', wasEscalationTriggered());
  await triggerEscalation({}, 'accepted');
  check('accepted escalation is not re-sent', calls === 1, `calls=${calls}`);

  resetEscalation();
  calls = 0;
  respond = () => false;
  await triggerEscalation({}, 'refused');
  check('refused escalation leaves the flag unset', !wasEscalationTriggered());
  await triggerEscalation({}, 'refused');
  check('refused escalation is retried on the next trigger', calls === 2, `calls=${calls}`);

  resetEscalation();
  calls = 0;
  respond = () => { throw new Error('host unavailable'); };
  let thrown = false;
  try { await triggerEscalation({}, 'thrown'); } catch { thrown = true; }
  check('failed callback propagates', thrown);
  check('failed escalation leaves the flag unset', !wasEscalationTriggered());
  respond = () => true;
  await triggerEscalation({}, 'thrown');
  check('failed escalation is retried and accepted', wasEscalationTriggered() && calls === 2, `calls=${calls}`);

  resetEscalation();
  calls = 0;
  const gate = Promise.withResolvers<boolean | undefined>();
  respond = () => gate.promise;
  const first = triggerEscalation({}, 'concurrent');
  const second = triggerEscalation({}, 'concurrent');
  gate.resolve(false);
  await Promise.all([first, second]);
  check('trigger while in flight is not re-sent', calls === 1, `calls=${calls}`);
  check('in-flight refusal leaves the flag unset', !wasEscalationTriggered());
  respond = () => true;
  await triggerEscalation({}, 'concurrent');
  check('next trigger after the in-flight call settles is sent', calls === 2 && wasEscalationTriggered(), `calls=${calls}`);
}

main().then(
  () => {
    finished = true;
    if (failures > 0) {
      console.log(`${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('escalation tests: all checks passed');
  },
  (e: unknown) => {
    finished = true;
    console.error(e);
    process.exit(1);
  },
);
