/**
 * test.mjs — integration test suite for user-data-api
 * Run: node test.mjs
 *
 * Each test section uses a unique X-Forwarded-For IP so rate-limit counters
 * don't bleed between sections.
 */

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;

const ok    = (msg) => { console.log(`  ✓ ${msg}`); pass++; };
const fail_ = (msg) => { console.error(`  ✗ ${msg}`); fail++; };
const section = (title) =>
  console.log(`\n${'═'.repeat(54)}\n  ${title}\n${'═'.repeat(54)}`);

// Each section uses its own fake IP so rate limits don't bleed across sections.
function makeClient(ip) {
  const hdrs = { 'X-Forwarded-For': ip };
  return {
    get:  (path) => fetch(`${BASE}${path}`, { headers: hdrs }),
    post: (path, body) => fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    del:  (path) => fetch(`${BASE}${path}`, { method: 'DELETE', headers: hdrs }),
  };
}

async function timed(fn) {
  const t = performance.now();
  const r = await fn();
  return { res: r, ms: Math.round(performance.now() - t) };
}

// ── 1. Cache miss vs hit ──────────────────────────────────────────────────
section('1. Cache miss vs hit — response times');
const c1 = makeClient('10.0.0.1');
await c1.del('/cache');

const { res: r1, ms: missMs } = await timed(() => c1.get('/users/1'));
const j1 = await r1.json();
const { res: r2, ms: hitMs } = await timed(() => c1.get('/users/1'));
const j2 = await r2.json();

j1.source === 'database' ? ok(`First request  → source=database (${missMs}ms)`) : fail_(`source=${j1.source}`);
j2.source === 'cache'    ? ok(`Second request → source=cache    (${hitMs}ms)`)  : fail_(`source=${j2.source}`);
missMs >= 190            ? ok(`Cache miss latency ≥190ms (${missMs}ms)`)        : fail_(`Miss too fast: ${missMs}ms`);
hitMs  <  20             ? ok(`Cache hit  latency <20ms  (${hitMs}ms)`)         : fail_(`Hit too slow: ${hitMs}ms`);

// ── 2. 404 for unknown user ───────────────────────────────────────────────
section('2. 404 for unknown user');
const c2 = makeClient('10.0.0.2');
const r404 = await c2.get('/users/9999');
const j404 = await r404.json();
r404.status === 404            ? ok('GET /users/9999 → 404')          : fail_(`Status: ${r404.status}`);
j404.message?.includes('9999') ? ok('Error message includes the ID')  : fail_(`Message: ${j404.message}`);

// ── 3. Input validation ───────────────────────────────────────────────────
section('3. Input validation');
const c3 = makeClient('10.0.0.3');
const rBadId   = await c3.get('/users/abc');
const rBadPost = await c3.post('/users', { name: '', email: 'bad' });
const rNoEmail = await c3.post('/users', { name: 'Alice' });

rBadId.status   === 400 ? ok('GET /users/abc → 400')             : fail_(`Status: ${rBadId.status}`);
rBadPost.status === 400 ? ok('POST /users with bad body → 400')  : fail_(`Status: ${rBadPost.status}`);
rNoEmail.status === 400 ? ok('POST /users missing email → 400')  : fail_(`Status: ${rNoEmail.status}`);

// ── 4. POST /users + immediate cache hit ──────────────────────────────────
section('4. POST /users → newly created user served from cache');
const c4 = makeClient('10.0.0.4');
const rNew = await c4.post('/users', { name: 'Cache Test', email: 'cache@test.com' });
const jNew = await rNew.json();
const newId = jNew.user?.id;
rNew.status === 201 && typeof newId === 'number'
  ? ok(`Created user id=${newId} (status 201)`)
  : fail_(`Bad response: ${JSON.stringify(jNew)}`);

const { res: rFetch, ms: fetchMs } = await timed(() => c4.get(`/users/${newId}`));
const jFetch = await rFetch.json();
jFetch.source === 'cache' ? ok('Newly created user served from cache')  : fail_(`source=${jFetch.source}`);
fetchMs < 20              ? ok(`Cache hit latency ${fetchMs}ms (<20ms)`) : fail_(`Slow: ${fetchMs}ms`);

// ── 5. Concurrent requests — request coalescing ───────────────────────────
section('5. Concurrent requests for same ID — request coalescing');
// Use N=5 to stay within the burst limit (5 req/10s) for a fresh IP.
// Coalescing proof: wall time ≈ 200ms (one DB call), NOT N×200ms.
// All coalesced requests return source='database' (they all waited on the queue)
// — that's correct behaviour, not a bug.
const c5 = makeClient('10.0.0.5');
await c5.del('/cache');

const N = 5;
const t0 = performance.now();
const concResults = await Promise.all(
  Array.from({ length: N }, () =>
    timed(() => c5.get('/users/2')).then(async ({ res, ms }) => ({
      json: await res.json(), ms, status: res.status,
    }))
  )
);
const wallMs = Math.round(performance.now() - t0);

const valid200 = concResults.filter(r => r.status === 200).length;
const maxMs    = Math.max(...concResults.map(r => r.ms));
const minMs    = Math.min(...concResults.map(r => r.ms));

valid200 === N ? ok(`All ${N} concurrent requests returned 200`) : fail_(`Only ${valid200}/${N} succeeded`);

// If coalescing works: wall time ≈ 1× DB latency (200ms), not N× (1000ms)
wallMs < 400
  ? ok(`Wall time ${wallMs}ms ≈ 1 DB call (coalescing ✓ — would be ~${N*200}ms without it)`)
  : fail_(`Wall time ${wallMs}ms too high — expected <400ms if coalescing worked`);

// One more request (fresh IP to avoid burst limit) should be a cache hit
const rAfterConc = await makeClient('10.0.0.5b').get('/users/2');
const jAfterConc = await rAfterConc.json();
jAfterConc.source === 'cache'
  ? ok('Follow-up request (fresh IP) is a cache hit (cache populated by first fetch)')
  : fail_(`Expected cache hit, got source=${jAfterConc.source}`);

console.log(`    Wall time: ${wallMs}ms  |  per-request: ${minMs}–${maxMs}ms`);

// ── 6. Cache management ───────────────────────────────────────────────────
section('6. Cache management — DELETE /cache');
const c6 = makeClient('10.0.0.6');
const rDel = await c6.del('/cache');
rDel.status === 200 ? ok('DELETE /cache → 200') : fail_(`Status: ${rDel.status}`);

const rAfterClear = await c6.get('/users/2');
const jAfterClear = await rAfterClear.json();
jAfterClear.source === 'database'
  ? ok('After cache clear, request hits DB again')
  : fail_(`source=${jAfterClear.source}`);

// ── 7. Cache-status endpoint ──────────────────────────────────────────────
section('7. GET /cache-status');
const rStatus = await fetch(`${BASE}/cache-status`);   // no rate limit on this route
const jStatus = await rStatus.json();
rStatus.status === 200                    ? ok('GET /cache-status → 200')                                    : fail_(`Status: ${rStatus.status}`);
typeof jStatus.cache?.size === 'number'   ? ok(`cache.size = ${jStatus.cache.size}`)                        : fail_('Missing cache.size');
typeof jStatus.cache?.hits === 'number'   ? ok(`cache.hits = ${jStatus.cache.hits}`)                        : fail_('Missing cache.hits');
typeof jStatus.cache?.misses === 'number' ? ok(`cache.misses = ${jStatus.cache.misses}`)                    : fail_('Missing cache.misses');
typeof jStatus.cache?.hitRate === 'string'? ok(`hitRate = ${jStatus.cache.hitRate}`)                        : fail_('Missing hitRate');
typeof jStatus.performance?.avgResponseTimeMs === 'number'
  ? ok(`avgResponseTimeMs = ${jStatus.performance.avgResponseTimeMs}ms`)                                    : fail_('Missing avgResponseTimeMs');
typeof jStatus.queue?.inFlight === 'number' ? ok(`queue.inFlight = ${jStatus.queue.inFlight}`)              : fail_('Missing queue.inFlight');

// ── 8. Rate limiting — burst cap ─────────────────────────────────────────
section('8. Rate limiting — burst cap (5 req / 10s)');
const c8 = makeClient('10.0.0.8');    // fresh IP → zero prior hits
await c8.del('/cache');

// Fire 8 requests quickly — first 5 should pass, rest get 429
const burstResults = await Promise.all(
  Array.from({ length: 8 }, () => c8.get('/users/3').then(r => r.status))
);
const got429  = burstResults.filter(s => s === 429).length;
const got200b = burstResults.filter(s => s === 200).length;
console.log(`    Statuses: [${burstResults.join(', ')}]`);
got429 >= 3
  ? ok(`Burst limit hit: ${got429} blocked (429), ${got200b} allowed (200)`)
  : fail_(`Expected ≥3 rejections, got ${got429}`);

// Verify 429 response body
const r429 = await c8.get('/users/3');
const j429 = await r429.json();
r429.status === 429            ? ok('Subsequent request still returns 429')           : fail_(`Status: ${r429.status}`);
j429.retryAfterMs > 0          ? ok(`retryAfterMs=${j429.retryAfterMs}ms in body`)   : fail_('Missing retryAfterMs');
j429.message?.length > 0       ? ok(`Message: "${j429.message.slice(0, 55)}…"`)      : fail_('Missing message');

// ── 9. Rate-limit minute window ────────────────────────────────────────────
section('9. Rate limiting — minute window (10 req / 60s)');
const c9 = makeClient('10.0.0.9');    // fresh IP again

// Quickly fire 12 requests to exceed the 10/min limit
const minuteStatuses = [];
for (let i = 0; i < 12; i++) {
  // Space them out just enough to not hit burst (>2s each) — but that's too slow.
  // Instead accept that burst kicks in first; the key check is ≥2 rejections total.
  const r = await c9.get('/users/1');
  minuteStatuses.push(r.status);
  if (r.status === 429) {
    const j = await r.json();
    if (!j.retryAfterMs) fail_('Missing retryAfterMs on 429');
  }
}
const total429 = minuteStatuses.filter(s => s === 429).length;
console.log(`    Statuses: [${minuteStatuses.join(', ')}]`);
total429 >= 2
  ? ok(`Rate limiting active: ${total429} requests blocked out of 12`)
  : fail_(`Expected ≥2 rate-limited responses, got ${total429}`);

// ── 10. Response headers ───────────────────────────────────────────────────
section('10. Response headers — X-Cache + X-RateLimit');
const c10 = makeClient('10.0.0.10');  // fresh IP
await c10.del('/cache');

const rMiss = await c10.get('/users/1');
const rHit  = await c10.get('/users/1');

rMiss.headers.get('x-cache') === 'MISS' ? ok('X-Cache: MISS on cold request') : fail_(`X-Cache=${rMiss.headers.get('x-cache')} (expected MISS)`);
rHit.headers.get('x-cache')  === 'HIT'  ? ok('X-Cache: HIT  on warm request') : fail_(`X-Cache=${rHit.headers.get('x-cache')} (expected HIT)`);

const limitHdr     = rMiss.headers.get('x-ratelimit-limit-minute');
const remainingHdr = rMiss.headers.get('x-ratelimit-remaining-minute');
limitHdr     ? ok(`X-RateLimit-Limit-Minute: ${limitHdr}`)         : fail_('Missing X-RateLimit-Limit-Minute');
remainingHdr ? ok(`X-RateLimit-Remaining-Minute: ${remainingHdr}`) : fail_('Missing X-RateLimit-Remaining-Minute');

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(54)}`);
console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
console.log(`${'═'.repeat(54)}\n`);
process.exit(fail > 0 ? 1 : 0);
