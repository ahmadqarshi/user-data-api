import { Router, Request, Response } from 'express';
import { LRUCache } from '../cache/lruCache';
import { getMetrics } from '../utils/logger';
import { User } from '../types';
import { logger } from '../utils/logger';
import { requestQueue } from '../queue/requestQueue';

export function createCacheRouter(cache: LRUCache<User>): Router {
  const router = Router();

  /**
   * GET /cache-status
   * Returns cache statistics, queue state, and average response time.
   */
  router.get('/cache-status', (_req: Request, res: Response): void => {
    const stats = cache.getStats();
    const metrics = getMetrics();

    res.json({
      cache: {
        size: stats.size,
        hits: stats.hits,
        misses: stats.misses,
        hitRate: stats.hits + stats.misses > 0
          ? `${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)}%`
          : 'N/A',
      },
      queue: {
        pending: requestQueue.pendingCount,
        inFlight: requestQueue.inFlightCount,
      },
      performance: {
        totalRequests: metrics.totalRequests,
        errorCount: metrics.errorCount,
        avgResponseTimeMs: metrics.avgResponseTimeMs,
      },
    });
  });

  /**
   * DELETE /cache
   * Clears the entire cache.
   */
  router.delete('/cache', (_req: Request, res: Response): void => {
    cache.clear();
    logger.info('[DELETE /cache] Cache cleared via API');
    res.json({ message: 'Cache cleared successfully.' });
  });

  return router;
}
