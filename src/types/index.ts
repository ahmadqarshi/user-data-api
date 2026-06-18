export interface User {
  id: number;
  name: string;
  email: string;
  createdAt?: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  avgResponseTimeMs: number;
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Doubly-linked list node for LRU eviction
export interface LRUNode<T> {
  key: string;
  entry: CacheEntry<T>;
  prev: LRUNode<T> | null;
  next: LRUNode<T> | null;
}

export interface RateLimitRecord {
  // Timestamps (ms) of all requests in the last 60 seconds
  minuteWindow: number[];
  // Timestamps (ms) of all requests in the last 10 seconds
  burstWindow: number[];
}

export interface RequestMetrics {
  totalRequests: number;
  totalResponseTimeMs: number;
  errorCount: number;
}
