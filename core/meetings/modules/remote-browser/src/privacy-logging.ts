type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const EVENTS: Record<LogLevel, string> = {
  info: JSON.stringify({ service: 'remote-browser', event: 'log_suppressed', level: 'info' }),
  warn: JSON.stringify({ service: 'remote-browser', event: 'log_suppressed', level: 'warn' }),
  error: JSON.stringify({ service: 'remote-browser', event: 'log_suppressed', level: 'error' }),
  debug: JSON.stringify({ service: 'remote-browser', event: 'log_suppressed', level: 'debug' }),
};

function writeSafe(level: LogLevel): void {
  const target = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  const original = (target as typeof target & { __remoteBrowserOriginalWrite?: typeof target.write }).__remoteBrowserOriginalWrite;
  original?.(`${EVENTS[level]}\n`);
}

export function installRemoteBrowserPrivacyLogging(): void {
  const state = globalThis as typeof globalThis & { __remoteBrowserPrivacyLogging?: boolean };
  if (state.__remoteBrowserPrivacyLogging) return;
  state.__remoteBrowserPrivacyLogging = true;

  const stdout = process.stdout as typeof process.stdout & { __remoteBrowserOriginalWrite?: typeof process.stdout.write };
  const stderr = process.stderr as typeof process.stderr & { __remoteBrowserOriginalWrite?: typeof process.stderr.write };
  stdout.__remoteBrowserOriginalWrite = process.stdout.write.bind(process.stdout);
  stderr.__remoteBrowserOriginalWrite = process.stderr.write.bind(process.stderr);

  const methods = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert'] as const) {
    const level: LogLevel = method === 'warn'
      ? 'warn'
      : method === 'error' || method === 'assert'
        ? 'error'
        : method === 'debug' || method === 'trace'
          ? 'debug'
          : 'info';
    methods[method] = () => writeSafe(level);
  }

  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      writeSafe(stream === process.stderr ? 'error' : 'info');
      done?.();
      return true;
    }) as typeof stream.write;
  }
}

installRemoteBrowserPrivacyLogging();
