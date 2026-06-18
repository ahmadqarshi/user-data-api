import { Router, Request, Response } from 'express';
import { LRUCache } from '../cache/lruCache';
import { requestQueue } from '../queue/requestQueue';
import { createUserInDB } from '../data/mockUsers';
import { rateLimiter } from '../middleware/rateLimiter';
import { recordRequest } from '../utils/logger';
import { User } from '../types';
import { logger } from '../utils/logger';

export function createUserRouter(cache: LRUCache<User>): Router {
  const router = Router();

  // Apply rate limiter to all /users routes
  router.use(rateLimiter);

  /**
   * GET /users/:id
   * Returns user by ID, served from cache when possible.
   */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const start = Date.now();
    const id = parseInt(req.params.id, 10);

    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Bad Request', message: 'User ID must be a positive integer.' });
      recordRequest(Date.now() - start, true);
      return;
    }

    const cacheKey = `user:${id}`;

    // ── Cache hit ───────────────────────────────────────────────────────────
    const cached = cache.get(cacheKey);
    if (cached) {
      const duration = Date.now() - start;
      logger.debug(`[GET /users/${id}] Cache HIT (${duration}ms)`);
      recordRequest(duration);
      res.setHeader('X-Cache', 'HIT');
      res.json({ source: 'cache', user: cached });
      return;
    }

    // ── Cache miss → queue DB fetch ─────────────────────────────────────────
    logger.debug(`[GET /users/${id}] Cache MISS – queuing DB fetch`);
    try {
      const user = await requestQueue.enqueue(id);

      if (!user) {
        const duration = Date.now() - start;
        recordRequest(duration, true);
        res.status(404).json({ error: 'Not Found', message: `User with ID ${id} does not exist.` });
        return;
      }

      // Populate cache only if not already populated by a concurrent request
      if (!cache.has(cacheKey)) {
        cache.set(cacheKey, user);
        logger.debug(`[GET /users/${id}] Cached user (${Date.now() - start}ms total)`);
      }

      const duration = Date.now() - start;
      recordRequest(duration);
      res.setHeader('X-Cache', 'MISS');
      res.json({ source: 'database', user });
    } catch (err) {
      const duration = Date.now() - start;
      recordRequest(duration, true);
      logger.error(`[GET /users/${id}] Unexpected error: ${err}`);
      res.status(500).json({ error: 'Internal Server Error', message: 'An unexpected error occurred.' });
    }
  });

  /**
   * POST /users
   * Creates a new user, persists to mock DB, and caches the result.
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const start = Date.now();
    const { name, email } = req.body as { name?: string; email?: string };

    if (!name || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'Bad Request', message: '`name` is required and must be a non-empty string.' });
      recordRequest(Date.now() - start, true);
      return;
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'Bad Request', message: '`email` is required and must be a valid email address.' });
      recordRequest(Date.now() - start, true);
      return;
    }

    try {
      const user = await createUserInDB({ name: name.trim(), email: email.trim() });
      cache.set(`user:${user.id}`, user);

      const duration = Date.now() - start;
      recordRequest(duration);
      logger.info(`[POST /users] Created user id=${user.id} (${duration}ms)`);
      res.status(201).json({ message: 'User created successfully.', user });
    } catch (err) {
      const duration = Date.now() - start;
      recordRequest(duration, true);
      logger.error(`[POST /users] Error: ${err}`);
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create user.' });
    }
  });

  return router;
}
