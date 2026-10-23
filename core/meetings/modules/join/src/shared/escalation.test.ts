// Escalation is one-shot only once the host accepts it. A refused or failed callback leaves the flag unset
// and is retried no sooner than ESCALATION_RETRY_COOLDOWN_MS later; a trigger while one is in flight does
// not send a second request. Time is passed in explicitly, so these checks never sleep.
import { ESCALATION_RETRY_COOLDOWN_MS, resetEscalation, triggerEscalation, wasEscalationTriggered } from './escalation';
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
  const COOLDOWN = ESCALATION_RETRY_COOLDOWN_MS;

  resetEscalation();
  calls = 0;
  respond = () => true;
  await triggerEscalation({}, 'accepted', 0);
  check('accepted escalation sets the one-shot flag', wasEscalationTriggered());
  await triggerEscalation({}, 'accepted', 10 * COOLDOWN);
  check('accepted escalation is not re-sent', calls === 1, `calls=${calls}`);

  resetEscalation();
  calls = 0;
  respond = () => false;
  await triggerEscalation({}, 'refused', 0);
  check('refused escalation leaves the flag unset', !wasEscalationTriggered());
  await triggerEscalation({}, 'refused', COOLDOWN - 1);
  check('refused escalation is not re-sent inside the cooldown', calls === 1, `calls=${calls}`);
  await triggerEscalation({}, 'refused', COOLDOWN);
  check('refused escalation is retried once the cooldown elapses', calls === 2, `calls=${calls}`);

  resetEscalation();
  calls = 0;
  respond = () => { throw new Error('host unavailable'); };
  let thrown = false;
  try { await triggerEscalation({}, 'thrown', 0); } catch { thrown = true; }
  check('failed callback propagates', thrown);
  check('failed escalation leaves the flag unset', !wasEscalationTriggered());
  respond = () => true;
  await triggerEscalation({}, 'thrown', COOLDOWN - 1);
  check('failed escalation is not re-sent inside the cooldown', calls === 1, `calls=${calls}`);
  await triggerEscalation({}, 'thrown', COOLDOWN);
  check('failed escalation is retried and accepted after the cooldown', wasEscalationTriggered() && calls === 2, `calls=${calls}`);

  resetEscalation();
  calls = 0;
  const gate = Promise.withResolvers<boolean | undefined>();
  respond = () => gate.promise;
  const first = triggerEscalation({}, 'concurrent', 0);
  const second = triggerEscalation({}, 'concurrent', 0);
  gate.resolve(false);
  await Promise.all([first, second]);
  check('trigger while in flight is not re-sent', calls === 1, `calls=${calls}`);
  check('in-flight refusal leaves the flag unset', !wasEscalationTriggered());
  respond = () => true;
  await triggerEscalation({}, 'concurrent', COOLDOWN);
  check('next trigger after the cooldown is sent and accepted', calls === 2 && wasEscalationTriggered(), `calls=${calls}`);

  // Persistent refusal sampled on a 1 s admission-check cadence for 10 virtual minutes.
  resetEscalation();
  calls = 0;
  respond = () => false;
  for (let t = 0; t < 600_000; t += 1_000) await triggerEscalation({}, 'persistent', t);
  check('persistent refusal: at most 20 deliveries in 10 virtual minutes', calls === 600_000 / COOLDOWN, `calls=${calls}`);
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
