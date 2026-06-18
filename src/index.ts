import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { LRUCache } from './cache/lruCache';
import { createUserRouter } from './routes/users';
import { createCacheRouter } from './routes/cache';
import { User } from './types';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// Shared LRU cache instance (capacity=1000, TTL=60s)
const cache = new LRUCache<User>(1000, 60_000);

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/users', createUserRouter(cache));
app.use('/',      createCacheRouter(cache));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found', message: 'The requested endpoint does not exist.' });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info(`Server listening on http://localhost:${PORT}`);
  logger.info('Endpoints:');
  logger.info('  GET    /users/:id      – fetch user (cache-first)');
  logger.info('  POST   /users          – create new user');
  logger.info('  GET    /cache-status   – cache & performance stats');
  logger.info('  DELETE /cache          – clear entire cache');
  logger.info('  GET    /health         – health check');
});

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info(`Received ${signal}. Shutting down gracefully…`);
  server.close(() => {
    cache.destroy();
    logger.info('Server closed.');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
