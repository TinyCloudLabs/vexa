import assert from 'node:assert/strict';
import { createResourceMonitor } from './resources.js';

const files = new Map([
  ['/sys/fs/cgroup/memory.current', '100'],
  ['/sys/fs/cgroup/memory.peak', '150'],
  ['/sys/fs/cgroup/memory.max', 'max'],
  ['/sys/fs/cgroup/memory.events', 'oom 3\noom_kill 2\n'],
]);
const monitor = createResourceMonitor({ read: (path) => { if (!files.has(path)) throw new Error('absent'); return files.get(path)!; }, nodeRss: () => 50 });
try {
  assert.deepEqual(monitor.snapshot(), { node_rss_bytes: 50, memory_current_bytes: 100, peak_memory_bytes: 150, sampled_peak_memory_bytes: 100, oom_kill_count: 2, oom_kill_delta: 0 });
  files.set('/sys/fs/cgroup/memory.current', '70');
  files.set('/sys/fs/cgroup/memory.events', 'oom 4\noom_kill 3\n');
  assert.equal(monitor.snapshot().sampled_peak_memory_bytes, 100);
  assert.equal(monitor.snapshot().oom_kill_delta, 1);
  files.set('/sys/fs/cgroup/memory.current', 'not a number');
  assert.equal(monitor.snapshot().memory_current_bytes, undefined);
} finally { monitor.stop(); }
const v1Files = new Map([
  ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '70'],
  ['/sys/fs/cgroup/memory/memory.max_usage_in_bytes', '90'],
  ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '120'],
]);
const v1 = createResourceMonitor({ read: (path) => { if (!v1Files.has(path)) throw new Error('absent'); return v1Files.get(path)!; }, nodeRss: () => 50 });
try {
  assert.deepEqual(v1.snapshot(), { node_rss_bytes: 50, memory_current_bytes: 70, peak_memory_bytes: 90, sampled_peak_memory_bytes: 70, memory_limit_bytes: 120 });
} finally { v1.stop(); }
let periodicCurrent = 10;
const periodic = createResourceMonitor({
  read: (path) => {
    if (path === '/sys/fs/cgroup/memory.current') return String(periodicCurrent);
    throw new Error('absent');
  },
  nodeRss: () => 50,
  intervalMs: 2,
});
try {
  periodicCurrent = 20;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(periodic.snapshot().sampled_peak_memory_bytes, 20, 'periodic samples update without a logger');
} finally { periodic.stop(); }
const absent = createResourceMonitor({ read: () => { throw new Error('no cgroups'); }, nodeRss: () => 50 });
try { assert.deepEqual(absent.snapshot(), { node_rss_bytes: 50 }); }
finally { absent.stop(); }
console.log('PASS memory evidence: kernel peak, sampled peak, OOM delta, and missing data stay distinct');
