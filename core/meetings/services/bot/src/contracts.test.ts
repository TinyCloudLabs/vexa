// The lifecycle.v1 transition table is the contract. These checks pin both the legal edges and the
// illegal ones, so an allow-all `canTransition` (or a widened table) fails here, not only downstream.
import { canTransition, LIFECYCLE_TRANSITIONS, type BotStatus } from './contracts.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const STATES = Object.keys(LIFECYCLE_TRANSITIONS) as BotStatus[];

const LEGAL: ReadonlyArray<readonly [BotStatus, BotStatus]> = [
  ['joining', 'awaiting_admission'],
  ['joining', 'needs_help'],
  ['joining', 'active'],
  ['joining', 'failed'],
  ['awaiting_admission', 'active'],
  ['awaiting_admission', 'needs_help'],
  ['awaiting_admission', 'failed'],
  ['needs_help', 'active'],
  ['needs_help', 'failed'],
  ['active', 'completed'],
  ['active', 'failed'],
];

// Every pair not in LEGAL, enumerated from the state set. Includes self-loops (not a transition here,
// same-status re-reports are handled by the orchestrator) and every backwards or terminal exit.
const legalSet = new Set(LEGAL.map(([a, b]) => `${a}>${b}`));
const ILLEGAL: Array<[BotStatus, BotStatus]> = [];
for (const from of STATES) for (const to of STATES) {
  if (from !== to && !legalSet.has(`${from}>${to}`)) ILLEGAL.push([from, to]);
}

console.log('\n=== lifecycle.v1 transition table ===');

check('table has exactly the six lifecycle.v1 states', STATES.length === 6, JSON.stringify(STATES));

for (const [from, to] of LEGAL) {
  check(`legal: ${from} → ${to}`, canTransition(from, to) === true);
}

for (const [from, to] of ILLEGAL) {
  check(`illegal: ${from} → ${to}`, canTransition(from, to) === false);
}

check('needs_help → awaiting_admission stays illegal (no re-entry to admission)',
  canTransition('needs_help', 'awaiting_admission') === false);
check('completed is terminal: no outgoing edge', LIFECYCLE_TRANSITIONS.completed.length === 0);
check('failed is terminal: no outgoing edge', LIFECYCLE_TRANSITIONS.failed.length === 0);

if (failed) {
  console.error(`\n❌ contracts transition table: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ contracts transition table: legal edges accepted, every other edge rejected.');
