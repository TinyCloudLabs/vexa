import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverEntrypoints, exclusionMatches } from './log-privacy-discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(readFileSync(path.join(root, 'scripts/log-privacy-entrypoints.json'), 'utf8'));
const columns = [
  ['Entrypoint (exact command/target)', 'target'],
  ['Service', 'service'],
  ['Used in deployed ptx-dev? (compose file:service, or no)', 'used_in_ptx_dev'],
  ['Privacy logging (module + function; handler/filter)', 'privacy'],
  ['Third-party middleware/library loggers (neutralizer)', 'third_party_loggers'],
  ['Test proving it', 'test'],
  ['Logging driver', 'logging_driver'],
];
const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
const thirdParty = (entry) => {
  const policies = inventory.third_party_loggers[entry.id].map((id) => inventory.third_party_logger_policies[id]);
  if (policies.length) return policies.map(({ library, neutralizer }) => `${library}: ${neutralizer}`).join('<br>');
  return entry.test_scope === 'ptx-shipper'
    ? 'External container; source allowlist drops this process.'
    : 'No third-party handler installer identified; process sink is sanitized by the listed privacy boundary.';
};
console.log(`| ${columns.map(([label]) => label).join(' | ')} |`);
console.log(`| ${columns.map(() => '---').join(' | ')} |`);
for (const entry of inventory.entries) {
  console.log(`| ${columns.map(([, key]) => cell(key === 'third_party_loggers' ? thirdParty(entry) : entry[key])).join(' | ')} |`);
}

const covered = new Set(inventory.entries.flatMap((entry) => entry.discovered ?? []));
const candidates = discoverEntrypoints(root).filter(({ key }) => !covered.has(key));
if (candidates.length) {
  console.log('\n### Explicitly excluded discovered targets');
  console.log('| Entrypoint source | Exact command/target | Exclusion reason |');
  console.log('| --- | --- | --- |');
  for (const candidate of candidates) {
    const exclusion = inventory.exclusions.find((item) =>
      (item.keys ?? []).includes(candidate.key)
      || (item.patterns ?? []).some((pattern) => exclusionMatches(pattern, candidate.key))
    );
    console.log(`| ${cell(candidate.key)} | ${cell(candidate.target)} | ${cell(exclusion?.reason ?? 'MISSING EXCLUSION')} |`);
  }
}
