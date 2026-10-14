import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(readFileSync(path.join(root, 'scripts/log-privacy-entrypoints.json'), 'utf8'));
const columns = [
  ['Entrypoint (exact command/target)', 'target'],
  ['Service', 'service'],
  ['Used in deployed ptx-dev? (compose file:service, or no)', 'used_in_ptx_dev'],
  ['Privacy logging (module + function; handler/filter)', 'privacy'],
  ['Test proving it', 'test'],
  ['Logging driver', 'logging_driver'],
];
const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
console.log(`| ${columns.map(([label]) => label).join(' | ')} |`);
console.log(`| ${columns.map(() => '---').join(' | ')} |`);
for (const entry of inventory.entries) {
  console.log(`| ${columns.map(([, key]) => cell(entry[key])).join(' | ')} |`);
}
