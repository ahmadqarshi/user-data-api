# user-data-api

A production-style Node.js/Express REST API written in TypeScript that demonstrates:

- **Custom LRU Cache** with TTL and background stale-entry eviction
- **Dual-window Rate Limiter** (per-minute + burst) with per-IP tracking
- **Async Request Queue** with single-flight request coalescing to prevent thundering-herd problems

---

## Features

| Feature | Details |
|---|---|
| LRU Cache | Custom doubly-linked-list + HashMap, O(1) get/set, 60 s TTL, background cleanup every 10 s |
| Rate Limiting | Sliding-window dual check: 10 req/min and 5 req/10 s per IP, returns 429 with `retryAfterMs` |
| Async Queue | Serialised DB fetches; concurrent requests for the same user ID are coalesced (single-flight) |
| Request Metrics | Tracks total requests, errors, and average response time, exposed via `/cache-status` |
| Graceful Shutdown | Handles `SIGTERM`/`SIGINT`, drains the HTTP server, and destroys the cache timer |

---

## Prerequisites

- **Node.js** 18 or later
- **npm** 9 or later

---

## Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd user-data-api

# 2. Install dependencies
npm install

# 3. Start in development mode (auto-reloads on save)
npm run dev

# --- OR ---

# 3b. Build and run the compiled output
npm run build
npm start
```

The server starts on **http://localhost:3000** by default.

---

## Endpoints

### GET /users/:id

Fetch a user by numeric ID. Served from the LRU cache on subsequent requests.

```bash
# First request – cache MISS (~200 ms, hits mock DB)
curl -i http://localhost:3000/users/1

# Second request – cache HIT (< 5 ms, served from memory)
curl -i http://localhost:3000/users/1
```

Response (cache miss):
```json
{
  "source": "database",
  "user": {
    "id": 1,
    "name": "John Doe",
    "email": "john@example.com",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

Response headers include:
- `X-Cache: HIT` or `X-Cache: MISS`
- `X-RateLimit-Limit-Minute`, `X-RateLimit-Remaining-Minute`
- `X-RateLimit-Limit-Burst`, `X-RateLimit-Remaining-Burst`

---

### POST /users

Create a new user. The new user is immediately written to the mock DB and inserted into the cache.

```bash
curl -i -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Bob Builder", "email": "bob@example.com"}'
```

Response (201 Created):
```json
{
  "message": "User created successfully.",
  "user": {
    "id": 4,
    "name": "Bob Builder",
    "email": "bob@example.com",
    "createdAt": "2026-06-18T12:00:00.000Z"
  }
}
```

---

### GET /cache-status

Returns a snapshot of cache statistics, queue state, and performance metrics.

```bash
curl http://localhost:3000/cache-status
```

Response:
```json
{
  "cache": {
    "size": 3,
    "hits": 5,
    "misses": 3,
    "hitRate": "62.5%"
  },
  "queue": {
    "pending": 0,
    "inFlight": 0
  },
  "performance": {
    "totalRequests": 8,
    "errorCount": 0,
    "avgResponseTimeMs": 52
  }
}
```

---

### DELETE /cache

Clears all entries from the LRU cache and resets hit/miss counters.

```bash
curl -i -X DELETE http://localhost:3000/cache
```

Response:
```json
{ "message": "Cache cleared successfully." }
```

---

### GET /health

Simple liveness probe.

```bash
curl http://localhost:3000/health
```

Response:
```json
{ "status": "ok", "uptime": 42.3 }
```

---

## Architecture

### LRU Cache (`src/cache/lruCache.ts`)

Implemented as a **doubly-linked list + HashMap** (the classic O(1) LRU design):

- `get(key)` – moves the accessed node to the **MRU** (most-recently-used) head of the list in O(1).
- `set(key, value)` – inserts at the MRU head; evicts the **LRU** (least-recently-used) tail node when the cache is at capacity.
- **TTL** – each entry stores an `expiresAt` timestamp. Expired entries are treated as misses on access and are lazily evicted.
- **Background cleanup** – `setInterval` runs every 10 s to proactively remove stale entries and free memory without waiting for a read.
- Two sentinel nodes (`head`, `tail`) eliminate all null-pointer edge cases.

### Rate Limiter (`src/middleware/rateLimiter.ts`)

A **dual sliding-window** algorithm applied per client IP:

| Window | Limit | Purpose |
|---|---|---|
| 60 seconds | 10 requests | Sustained rate cap |
| 10 seconds | 5 requests | Burst protection |

Each window stores an array of request timestamps. On every request the array is filtered to drop timestamps older than the window duration, making it a true sliding window rather than a fixed bucket.

When a limit is exceeded the response is `429 Too Many Requests` with:
- `retryAfterMs` – exact milliseconds until the oldest timestamp ages out of the window.

A `setInterval` prunes inactive IP records every 5 minutes to prevent unbounded memory growth.

### Async Queue + Request Coalescing (`src/queue/requestQueue.ts`)

The `RequestQueue` solves two problems:

1. **Serialisation** – DB fetches are processed one at a time via a simple FIFO queue, preventing connection storms.
2. **Single-flight / request coalescing** – if a fetch for user ID `X` is already in flight and another request arrives for the same `X`, the second caller is added to a waitlist instead of triggering a second DB query. Both callers receive the same result when the first fetch completes.

This mirrors the `singleflight` pattern common in Go services and is critical for cache-miss spikes (e.g., after a cache clear).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the HTTP server binds to |
| `LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, `error` |

Example:
```bash
PORT=8080 LOG_LEVEL=debug npm run dev
```

---

## Testing Guide

### Observe cache behaviour (first vs. subsequent request timing)

```bash
# First call: cache MISS, expect ~200 ms (mock DB delay)
time curl -s http://localhost:3000/users/1 | jq .source

# Second call: cache HIT, expect < 5 ms
time curl -s http://localhost:3000/users/1 | jq .source
```

### Verify request coalescing

```bash
# Fire 5 simultaneous requests for the same user – only 1 DB fetch should occur
for i in $(seq 5); do curl -s http://localhost:3000/users/2 & done; wait
```

Check the server logs; you should see a single `[Queue] Fetching userId=2 from DB` line followed by four `[Queue] Coalescing request for userId=2` lines.

### Trigger the rate limiter (burst window)

```bash
# 6 rapid requests – the 6th should return 429
for i in $(seq 6); do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/users/1
done
```

Expected output: five `200` responses followed by one `429`.

### Check cache statistics

```bash
curl -s http://localhost:3000/cache-status | jq .
```

### Clear the cache and re-test

```bash
curl -s -X DELETE http://localhost:3000/cache
curl -s http://localhost:3000/users/1 | jq .source   # "database" again
```
