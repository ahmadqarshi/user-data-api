import { User } from '../types';
import { fetchUserFromDB } from '../data/mockUsers';
import { logger } from '../utils/logger';

type Resolver = (user: User | null) => void;
type Rejecter = (err: unknown) => void;

interface QueueItem {
  userId: number;
  resolve: Resolver;
  reject: Rejecter;
}

/**
 * RequestQueue serialises DB fetch requests and de-duplicates in-flight
 * requests for the same user ID (request coalescing).
 *
 * If a fetch for ID X is already running, any new request for X is held in a
 * "waitlist" and receives the same result once the first fetch completes.
 */
export class RequestQueue {
  // Pending items waiting to be processed
  private queue: QueueItem[] = [];
  // In-flight: userId → list of {resolve, reject} waiting on that fetch
  private inFlight: Map<number, Array<{ resolve: Resolver; reject: Rejecter }>> = new Map();
  private processing = false;

  /**
   * Enqueue a fetch for userId.
   * Returns a promise that resolves with the User or null.
   */
  enqueue(userId: number): Promise<User | null> {
    // ── Request coalescing ──────────────────────────────────────────────────
    if (this.inFlight.has(userId)) {
      logger.debug(`[Queue] Coalescing request for userId=${userId}`);
      return new Promise<User | null>((resolve, reject) => {
        this.inFlight.get(userId)!.push({ resolve, reject });
      });
    }

    return new Promise<User | null>((resolve, reject) => {
      this.queue.push({ userId, resolve, reject });
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const { userId, resolve, reject } = item;

      // Register this as an in-flight fetch; add the original caller to waitlist
      this.inFlight.set(userId, [{ resolve, reject }]);

      try {
        logger.debug(`[Queue] Fetching userId=${userId} from DB`);
        const user = await fetchUserFromDB(userId);

        // Resolve all waitlisted callers
        const waiters = this.inFlight.get(userId) ?? [];
        this.inFlight.delete(userId);
        for (const { resolve: res } of waiters) res(user);
      } catch (err) {
        const waiters = this.inFlight.get(userId) ?? [];
        this.inFlight.delete(userId);
        for (const { reject: rej } of waiters) rej(err);
      }
    }

    this.processing = false;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }
}

// Singleton instance shared across routes
export const requestQueue = new RequestQueue();
