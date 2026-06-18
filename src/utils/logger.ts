import { RequestMetrics } from '../types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: LogLevel, message: string): void {
  if (levels[level] < levels[LOG_LEVEL]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}`;
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (msg: string) => log('debug', msg),
  info:  (msg: string) => log('info',  msg),
  warn:  (msg: string) => log('warn',  msg),
  error: (msg: string) => log('error', msg),
};

// ── Request metrics tracker ──────────────────────────────────────────────────

const metrics: RequestMetrics = {
  totalRequests: 0,
  totalResponseTimeMs: 0,
  errorCount: 0,
};

export function recordRequest(durationMs: number, isError = false): void {
  metrics.totalRequests++;
  metrics.totalResponseTimeMs += durationMs;
  if (isError) metrics.errorCount++;
}

export function getMetrics(): RequestMetrics & { avgResponseTimeMs: number } {
  return {
    ...metrics,
    avgResponseTimeMs:
      metrics.totalRequests > 0
        ? Math.round(metrics.totalResponseTimeMs / metrics.totalRequests)
        : 0,
  };
}

export function resetMetrics(): void {
  metrics.totalRequests = 0;
  metrics.totalResponseTimeMs = 0;
  metrics.errorCount = 0;
}
