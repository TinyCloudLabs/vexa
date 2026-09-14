/** Container memory evidence. Missing cgroup files remain unknown, never zero usage. */
import { readFileSync } from 'node:fs';
import type { LifecycleEvent } from './contracts.js';

type Resources = NonNullable<LifecycleEvent['bot_resources']>;

export function createResourceMonitor(opts: {
  read?: (path: string) => string;
  nodeRss?: () => number;
  log?: (message: string) => void;
  intervalMs?: number;
} = {}) {
  const read = opts.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const contents = (path: string): string | undefined => {
    try { return read(path).trim(); } catch { return undefined; }
  };
  const numeric = (value: string | undefined): number | undefined => {
    if (!value || !/^\d+$/.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  };
  const oomKills = (): number | undefined => {
    const events = contents('/sys/fs/cgroup/memory.events');
    return numeric(events?.match(/^oom_kill\s+(\d+)$/m)?.[1]);
  };
  const initialOomKills = oomKills();
  let sampledPeak: number | undefined;
  const snapshot = (): Resources => {
    const current = numeric(contents('/sys/fs/cgroup/memory.current'))
      ?? numeric(contents('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
    const peak = numeric(contents('/sys/fs/cgroup/memory.peak'))
      ?? numeric(contents('/sys/fs/cgroup/memory/memory.max_usage_in_bytes'));
    if (current !== undefined) sampledPeak = Math.max(sampledPeak ?? 0, current);
    const limit = numeric(contents('/sys/fs/cgroup/memory.max'));
    const kills = oomKills();
    return {
      node_rss_bytes: (opts.nodeRss ?? (() => process.memoryUsage().rss))(),
      ...(current === undefined ? {} : { memory_current_bytes: current }),
      ...(peak === undefined ? {} : { peak_memory_bytes: peak }),
      ...(sampledPeak === undefined ? {} : { sampled_peak_memory_bytes: sampledPeak }),
      ...(limit === undefined ? {} : { memory_limit_bytes: limit }),
      ...(kills === undefined ? {} : { oom_kill_count: kills }),
      ...(kills === undefined || initialOomKills === undefined ? {} : { oom_kill_delta: Math.max(0, kills - initialOomKills) }),
    };
  };
  const report = () => {
    try { opts.log?.(`[bot] resources ${JSON.stringify(snapshot())}`); } catch { /* diagnostic cannot affect capture */ }
  };
  report();
  const timer = setInterval(report, opts.intervalMs ?? 30_000);
  timer.unref();
  return { snapshot, stop() { clearInterval(timer); } };
}
