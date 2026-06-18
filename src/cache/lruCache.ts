import { CacheEntry, CacheStats, LRUNode } from '../types';
import { logger } from '../utils/logger';

const DEFAULT_TTL_MS = 60_000; // 60 seconds
const CLEANUP_INTERVAL_MS = 10_000; // run cleanup every 10 seconds

export class LRUCache<T> {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly map: Map<string, LRUNode<T>>;

  // Sentinel head (MRU side) and tail (LRU side)
  private head: LRUNode<T>;
  private tail: LRUNode<T>;

  // Stats
  private hits = 0;
  private misses = 0;

  // Background cleanup timer
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(capacity = 1000, ttlMs = DEFAULT_TTL_MS) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();

    // Sentinel nodes simplify edge-case handling
    this.head = this.createSentinel();
    this.tail = this.createSentinel();
    this.head.next = this.tail;
    this.tail.prev = this.head;

    // Start background stale-entry cleanup
    this.cleanupTimer = setInterval(() => this.evictStale(), CLEANUP_INTERVAL_MS);
    // Don't block process exit
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /** Retrieve an item. Returns undefined on miss or expiry. */
  get(key: string): T | undefined {
    const node = this.map.get(key);
    if (!node) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > node.entry.expiresAt) {
      // Expired – treat as miss and evict
      this.removeNode(node);
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // Move to MRU position
    this.moveToFront(node);
    this.hits++;
    return node.entry.value;
  }

  /** Insert or update an item. */
  set(key: string, value: T): void {
    if (this.map.has(key)) {
      const node = this.map.get(key)!;
      node.entry = { value, expiresAt: Date.now() + this.ttlMs };
      this.moveToFront(node);
      return;
    }

    if (this.map.size >= this.capacity) {
      this.evictLRU();
    }

    const node: LRUNode<T> = {
      key,
      entry: { value, expiresAt: Date.now() + this.ttlMs },
      prev: null,
      next: null,
    };
    this.map.set(key, node);
    this.addToFront(node);
  }

  /** Remove a specific key. */
  delete(key: string): void {
    const node = this.map.get(key);
    if (node) {
      this.removeNode(node);
      this.map.delete(key);
    }
  }

  /** Clear all entries and reset stats. */
  clear(): void {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.hits = 0;
    this.misses = 0;
    logger.info('[Cache] Cache cleared');
  }

  /** Returns whether a non-expired entry exists for key. */
  has(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    if (Date.now() > node.entry.expiresAt) {
      this.removeNode(node);
      this.map.delete(key);
      return false;
    }
    return true;
  }

  getStats(): Omit<CacheStats, 'avgResponseTimeMs'> {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
    };
  }

  /** Stop the background cleanup timer. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private createSentinel(): LRUNode<T> {
    return {
      key: '__sentinel__',
      entry: { value: null as unknown as T, expiresAt: Infinity },
      prev: null,
      next: null,
    };
  }

  private addToFront(node: LRUNode<T>): void {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next!.prev = node;
    this.head.next = node;
  }

  private removeNode(node: LRUNode<T>): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
  }

  private moveToFront(node: LRUNode<T>): void {
    this.removeNode(node);
    this.addToFront(node);
  }

  private evictLRU(): void {
    const lru = this.tail.prev!;
    if (lru === this.head) return; // empty
    this.removeNode(lru);
    this.map.delete(lru.key);
    logger.debug(`[Cache] LRU eviction: key=${lru.key}`);
  }

  private evictStale(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, node] of this.map) {
      if (now > node.entry.expiresAt) {
        this.removeNode(node);
        this.map.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.debug(`[Cache] Background cleanup removed ${evicted} stale entries`);
    }
  }
}
