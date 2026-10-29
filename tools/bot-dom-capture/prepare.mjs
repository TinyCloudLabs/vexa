import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

let options;
try {
  options = parseArgs({ options: {
    'local-only': { type: 'boolean', default: false },
    output: { type: 'string' },
    checkpoints: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } }).values;
} catch {
  console.error('LOCAL_CAPTURE_INVALID_ARGUMENTS');
  process.exit(2);
}
if (options.help) {
  console.log('node tools/bot-dom-capture/prepare.mjs --local-only --output <fresh-private-directory> [--checkpoints]');
  process.exit(0);
}
if (!options['local-only']) {
  console.error('LOCAL_CAPTURE_OPT_IN_REQUIRED');
  process.exit(2);
}
if (!options.output) {
  console.error('LOCAL_CAPTURE_OUTPUT_REQUIRED');
  process.exit(2);
}
const output = resolve(options.output);
try {
  mkdirSync(output, { mode: 0o700 });
} catch {
  console.error('LOCAL_CAPTURE_FRESH_DIRECTORY_REQUIRED');
  process.exit(2);
}
const marker = { local_only: true, mode: options.checkpoints ? 'checkpoints' : 'failure', format_version: 1 };
const tool = dirname(fileURLToPath(import.meta.url));
try {
  writeFileSync(resolve(output, 'LOCAL_DIAGNOSTIC_ONLY.json'), JSON.stringify(marker) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(resolve(output, 'docker-options.private.json'), JSON.stringify({
    mounts: [
      { source: tool, target: '/opt/vexa-local-dom-capture', readOnly: true },
      { source: output, target: '/var/local/vexa-dom-capture', readOnly: false },
    ],
    environment: { NODE_OPTIONS: '--require=/opt/vexa-local-dom-capture/preload.cjs' },
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
} catch {
  console.error('LOCAL_CAPTURE_PREPARATION_FAILED');
  process.exit(2);
}
console.log('LOCAL_CAPTURE_PREPARED');
