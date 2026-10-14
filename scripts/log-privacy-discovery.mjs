import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', '.venv', 'node_modules', 'dist', 'build', 'coverage', '.turbo', '.next']);
const EXECUTABLE_SCRIPT = /(?:^|[\s;&|])(?:pnpm\s+exec\s+|npx\s+)?(?:node|tsx|bun|python(?:\d+(?:\.\d+)?)?)(?=\s|$)/;

function filesUnder(root) {
  const result = [];
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) visit(absolute);
      } else if (item.isFile()) {
        result.push(absolute);
      }
    }
  };
  visit(root);
  return result;
}

function read(root, file) {
  return readFileSync(path.join(root, file), 'utf8');
}

function packageCandidates(root, file) {
  const pkg = JSON.parse(read(root, file));
  const candidates = [];
  if (typeof pkg.bin === 'string') {
    const name = pkg.name?.split('/').at(-1) ?? path.basename(path.dirname(file));
    candidates.push({
      key: `package:${file}#bin:${name}`,
      kind: 'package-bin',
      target: `${name}: ${pkg.bin}`,
    });
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, target] of Object.entries(pkg.bin)) {
      candidates.push({ key: `package:${file}#bin:${name}`, kind: 'package-bin', target: `${name}: ${target}` });
    }
  }
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (typeof command === 'string' && EXECUTABLE_SCRIPT.test(command)) {
      candidates.push({
        key: `package:${file}#script:${name}`,
        kind: 'package-script',
        target: command,
      });
    }
  }
  return candidates;
}

function dockerfileCandidates(root, file) {
  const lines = read(root, file).split(/\r?\n/);
  const counts = new Map();
  const candidates = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*(CMD|ENTRYPOINT)\s+(.+)$/i);
    if (!match) continue;
    const directive = match[1].toUpperCase();
    const ordinal = counts.get(directive) ?? 0;
    counts.set(directive, ordinal + 1);
    let target = match[2].trim();
    while (target.endsWith('\\') && index + 1 < lines.length) target = `${target.slice(0, -1)} ${lines[++index].trim()}`;
    candidates.push({
      key: `dockerfile:${file}#${directive.toLowerCase()}:${ordinal}`,
      kind: 'dockerfile',
      target,
    });
  }
  return candidates;
}

function composeCandidates(root, file) {
  const lines = read(root, file).split(/\r?\n/);
  const candidates = [];
  let inServices = false;
  let service = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*services:\s*(?:#.*)?$/.test(line)) {
      inServices = true;
      service = null;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) {
      inServices = false;
      service = null;
      continue;
    }
    const serviceMatch = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (serviceMatch) {
      service = serviceMatch[1];
      continue;
    }
    const fieldMatch = line.match(/^ {4}(command|entrypoint):(?:\s*(.*))?$/i);
    if (!service || !fieldMatch) continue;
    const field = fieldMatch[1].toLowerCase();
    let target = (fieldMatch[2] ?? '').trim();
    const fieldIndent = line.match(/^\s*/)[0].length;
    if (!target || target === '|' || target === '>' || target === '|-' || target === '>-') {
      const block = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() && next.match(/^\s*/)[0].length <= fieldIndent) break;
        block.push(lines[++index].trim());
      }
      target = block.join(' ');
    }
    candidates.push({
      key: `compose:${file}#${service}:${field}`,
      kind: 'compose',
      target,
    });
  }
  return candidates;
}

function pythonCandidates(root, file) {
  const text = read(root, file);
  if (!(file.endsWith('/__main__.py') || /if\s+__name__\s*==\s*['"]__main__['"]/.test(text))) return [];
  return [{
    key: `python:${file}`,
    kind: 'python-main',
    target: file.replace(/\.py$/, '').replaceAll('/', '.'),
  }];
}

function projectScriptCandidates(root, file) {
  const text = read(root, file);
  const start = text.indexOf('[project.scripts]');
  if (start < 0) return [];
  const section = text.slice(start + '[project.scripts]'.length).split(/^\s*\[/m, 1)[0];
  return [...section.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/gm)].map(([, name, target]) => ({
    key: `pyproject:${file}#script:${name}`,
    kind: 'project-script',
    target: target.replace(/^['"]|['"]$/g, ''),
  }));
}

export function discoverEntrypoints(root) {
  const candidates = [];
  for (const absolute of filesUnder(root)) {
    const file = path.relative(root, absolute).split(path.sep).join('/');
    const base = path.basename(file);
    if (base === 'package.json') candidates.push(...packageCandidates(root, file));
    if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) candidates.push(...dockerfileCandidates(root, file));
    if (/^(?:docker-)?compose.*\.ya?ml$/i.test(base)) candidates.push(...composeCandidates(root, file));
    if (file.endsWith('.py')) candidates.push(...pythonCandidates(root, file));
    if (base === 'pyproject.toml') candidates.push(...projectScriptCandidates(root, file));
  }
  return candidates.sort((left, right) => left.key.localeCompare(right.key));
}

function matchesKey(pattern, key) {
  const expression = `^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`;
  return new RegExp(expression).test(key);
}

export function uncoveredEntrypoints(candidates, inventory) {
  const covered = new Set(inventory.entries.flatMap((entry) => entry.discovered ?? []));
  const exclusions = inventory.exclusions ?? [];
  return candidates.filter((candidate) => {
    if (covered.has(candidate.key)) return false;
    return !exclusions.some((item) =>
      (item.keys ?? []).includes(candidate.key)
      || (item.patterns ?? []).some((pattern) => matchesKey(pattern, candidate.key))
    );
  });
}

export function exclusionMatches(pattern, key) {
  return matchesKey(pattern, key);
}
