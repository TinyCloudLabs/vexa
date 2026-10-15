import './install-process-log-sanitizer.js';

function exitOnFatal(kind: 'uncaught_exception' | 'unhandled_rejection'): void {
  const event = {
    level: 'fatal',
    event: 'process.fatal',
    kind,
    error_code: 'operation_failed',
  };
  process.stderr.write(`${JSON.stringify(event)}\n`, () => process.exit(1));
}

process.on('uncaughtException', () => exitOnFatal('uncaught_exception'));
process.on('unhandledRejection', () => exitOnFatal('unhandled_rejection'));
