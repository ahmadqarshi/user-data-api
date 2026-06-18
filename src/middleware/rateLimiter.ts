import { Request, Response, NextFunction } from 'express';
import { RateLimitRecord } from '../types';
import { logger } from '../utils/logger';

const MINUTE_WINDOW_MS = 60_000;
const BURST_WINDOW_MS  = 10_000;
const MINUTE_MAX       = 10;   // max requests per 60 s
const BURST_MAX        = 5;    // max requests per 10 s (burst)

// IP → rate limit record
const records: Map<string, RateLimitRecord> = new Map();

// Prune dead records every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - MINUTE_WINDOW_MS;
  for (const [ip, rec] of records) {
    if (rec.minuteWindow.length === 0 || rec.minuteWindow[rec.minuteWindow.length - 1] < cutoff) {
      records.delete(ip);
    }
  }
}, 5 * 60_000).unref();

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? '0.0.0.0';
}

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip  = getClientIp(req);
  const now = Date.now();

  if (!records.has(ip)) {
    records.set(ip, { minuteWindow: [], burstWindow: [] });
  }
  const rec = records.get(ip)!;

  // Slide windows: drop timestamps older than their respective windows
  rec.minuteWindow = rec.minuteWindow.filter(t => now - t < MINUTE_WINDOW_MS);
  rec.burstWindow  = rec.burstWindow.filter(t => now - t < BURST_WINDOW_MS);

  // Enforce burst limit first (stricter short window)
  if (rec.burstWindow.length >= BURST_MAX) {
    const retryAfterMs = BURST_WINDOW_MS - (now - rec.burstWindow[0]);
    logger.warn(`[RateLimit] Burst limit exceeded for IP ${ip}`);
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Burst limit of ${BURST_MAX} requests per 10 seconds exceeded. Please slow down.`,
      retryAfterMs,
    });
    return;
  }

  // Enforce per-minute limit
  if (rec.minuteWindow.length >= MINUTE_MAX) {
    const retryAfterMs = MINUTE_WINDOW_MS - (now - rec.minuteWindow[0]);
    logger.warn(`[RateLimit] Minute limit exceeded for IP ${ip}`);
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit of ${MINUTE_MAX} requests per minute exceeded.`,
      retryAfterMs,
    });
    return;
  }

  // Record this request
  rec.minuteWindow.push(now);
  rec.burstWindow.push(now);

  // Expose rate-limit headers
  res.setHeader('X-RateLimit-Limit-Minute', MINUTE_MAX);
  res.setHeader('X-RateLimit-Remaining-Minute', MINUTE_MAX - rec.minuteWindow.length);
  res.setHeader('X-RateLimit-Limit-Burst', BURST_MAX);
  res.setHeader('X-RateLimit-Remaining-Burst', BURST_MAX - rec.burstWindow.length);

  next();
}
