# Reneo Backend API

Multi-seller commerce platform REST API — Backend Developer Internship Assessment.

**Stack**: Node.js · TypeScript · Express · Supabase · PostgreSQL

---

## Setup

### Prerequisites
- Node.js 18+
- A Supabase project (free tier works)
- Supabase CLI (optional, for migration management)

### Installation

```bash
git clone https://github.com/Chandradeep05/reneo-backend.git
cd reneo-backend
npm install
cp .env.example .env
# Fill in your Supabase credentials in .env
```

### Environment Variables

```
SUPABASE_URL              # Your Supabase project URL
SUPABASE_ANON_KEY         # Supabase publishable/anon key
SUPABASE_SERVICE_ROLE_KEY # Service role key (server-side only — never expose)
DATABASE_URL              # Direct PostgreSQL connection string (for transactions)
PORT                      # Server port (default: 3000)
NODE_ENV                  # development | production | test
CORS_ORIGIN               # Allowed CORS origin
```

### Database Setup

Run migrations in order against your Supabase project:

```bash
# Option 1: Supabase CLI
supabase db push

# Option 2: Manual via Supabase Studio → SQL Editor
# Run files in order: 001 → 002 → 003 → 004
```

### Run

```bash
npm run dev    # Development (hot reload)
npm start      # Production
```

### Test

```bash
npm test                      # Full test suite
npm run test:concurrency      # Run Test 5 (race condition) with verbose output
npm run test:coverage         # Coverage report
```

---

## API Endpoints

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /auth/register | None | Create account (role: SELLER/CUSTOMER) |
| POST | /auth/login | None | Get JWT token |
| POST | /auth/logout | Bearer | Invalidate session |

### Products
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /products | SELLER | Create product + inventory |
| GET | /products | Any | List with FTS, filters, pagination |
| GET | /products/:id | Any | Single product + stock |
| PATCH | /products/:id | SELLER (own) | Update fields |
| DELETE | /products/:id | SELLER (own) | Soft archive |

### Orders
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /orders | CUSTOMER | Place order (atomic, server-resolved price) |
| GET | /orders | CUSTOMER | Own order history |
| GET | /orders/:id | CUSTOMER | Order detail + items |

### Stores
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /stores | SELLER | Create store (one per seller) |
| GET | /stores/:slug | Any | Store profile + products |

---

## Technical Decisions

### Money: `BIGINT` (whole FCFA)

Prices stored as `BIGINT` representing whole CFA Francs (FCFA). FCFA has no subunit. This eliminates floating-point rounding bugs entirely. Columns named `*_fcfa` to make the unit explicit in every query and response.

### Order Price: Server-Owned

The order schema uses `.strict()` which **rejects any unknown field with 400**. If a client sends `price` or `price_fcfa` in the order payload, the request fails immediately. Price is always read from the `products` table inside the locked transaction — the client cannot influence it.

```json
// This order body is REJECTED (400):
{ "items": [{ "product_id": "...", "quantity": 1, "price": 50 }] }

// This is ACCEPTED:
{ "items": [{ "product_id": "...", "quantity": 1 }] }
```

### Concurrency: `SELECT FOR UPDATE`

The most critical implementation detail. When stock = 1 and two customers race:

```
Transaction A                 Transaction B

BEGIN                         BEGIN
SELECT ... FOR UPDATE ← A gets lock
                              SELECT ... FOR UPDATE ← B WAITS (blocked)
quantity = 1 ✓
deduct → quantity = 0
INSERT order
COMMIT ← lock released
                              ← B acquires lock
                              re-reads quantity = 0
                              stock check fails
                              ROLLBACK → 409
```

**Why not SKIP LOCKED?** `SKIP LOCKED` is for job queues — it skips locked rows and processes others. For stock, we need Transaction B to **wait** and then re-read the committed (zero) quantity. That's exactly what `FOR UPDATE` provides.

**Deadlock prevention**: Product IDs are sorted before locking. Two orders involving the same products always acquire locks in the same alphabetical order, preventing circular waiting.

### Inventory: Separate Table

`inventory` is its own table (not a column on `products`). This allows `FOR UPDATE` to lock only the stock row, not the entire product row. Price reads and stock updates don't interfere with each other.

### Idempotency: Atomic Inside Transaction

The idempotency key is **inserted inside the transaction**, not before it. This prevents the following race:

```
// WRONG (old plan): check before tx → race window → save after commit
Request A: check key = none → BEGIN → commit → save key
Request B: check key = none → BEGIN → commit → save key  ← two orders!

// CORRECT (implemented): insert key inside tx → unique constraint handles race
Request A: BEGIN → INSERT key → process → COMMIT
Request B: BEGIN → INSERT key → UNIQUE VIOLATION (23505) → return cached response
```

The PostgreSQL `UNIQUE` constraint on `orders.idempotency_key` is the actual deduplication mechanism. The `idempotency_keys` table stores the cached response for returning to the client.

TTL: 24 hours. After that, the same key can be reused.

### Transactional Outbox (B3)

`ORDER_CREATED` events are written to `event_outbox` **in the same transaction** as the order. If the transaction rolls back, the event is never written. If the server crashes after commit, the outbox poller picks it up on restart.

```
BEGIN
├── UPDATE inventory (deduct stock)
├── INSERT order
├── INSERT order_items
└── INSERT event_outbox  ← same transaction, guaranteed atomicity
COMMIT

Outbox poller (every 2s):
└── SELECT ... FOR UPDATE SKIP LOCKED
└── publishToRealtime()
└── UPDATE event_outbox SET published = true
```

**Known limitation**: Supabase Realtime `broadcast` is ephemeral. If the seller's client is not connected when we publish, they don't receive the notification — even though `published = true`. A durable `notifications` table (queryable on next login) is a planned improvement. See D2.

### RLS + pg Pool Tradeoff

The order placement service uses a raw `pg.Pool` connection (via `DATABASE_URL`) for explicit transaction control (`BEGIN` / `SELECT FOR UPDATE` / `COMMIT`). This connection does not carry `auth.uid()` context — Supabase RLS policies do not apply to queries run through this pool.

**This is an intentional, documented limitation — not a security hole.** The `placeOrder()` function enforces authorization at the service layer:
- `customerId` is always extracted from the **verified JWT** (via `auth.middleware.ts`) and passed explicitly as a SQL parameter — it never comes from `req.body`
- Cross-seller product access is prevented via a JOIN: `stores.seller_id = $sellerId`
- The idempotency key is scoped to `orders.customer_id` — a different customer cannot retrieve another customer's order via their key

**What the database does enforce** (independently of this pool):
- RLS on `products` — Supabase-js reads respect seller ownership
- `CHECK (quantity >= 0)` on inventory — negative stock is impossible at the DB level
- `UNIQUE` on `orders.idempotency_key` — duplicate orders are structurally impossible
- `FK` constraints — orphaned order_items are impossible

This tradeoff is made explicitly to unlock `SELECT FOR UPDATE` — which `supabase-js` does not expose. The database-level constraints above provide structural integrity; the service layer provides authorization.

For supabase-js operations (product reads, profile lookups), RLS applies normally. The `products_seller_update` and `products_seller_delete` policies catch cross-seller attempts made via any direct Supabase client path.

### Soft Delete

Products are never hard-deleted — `is_archived = true` is set instead. Hard delete would violate the `order_items.product_id` FK constraint. Purchase history is immutable.

### Cursor Pagination

`GET /products` uses cursor-based pagination. `OFFSET` pagination is O(N) — scanning 1M rows for page 50,000 is unacceptable. Cursor pagination is O(log N) via the GIN/composite indexes.

The cursor encodes `(sort_value, created_at, id)` where `sort_value` is the **primary sort dimension**:
- `newest` / `oldest` / `relevance`: `sort_value = created_at`
- `price_asc` / `price_desc`: `sort_value = price_fcfa`

The `WHERE` clause in each query always matches its `ORDER BY` — ensuring page 2+ never returns duplicate or skipped rows, even when prices collide.

---

## EXPLAIN Output

Main product search query with FTS + pagination (actual output from live Supabase instance):

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT p.id, p.name, p.price_fcfa, COALESCE(i.quantity, 0) AS stock
FROM products p
LEFT JOIN inventory i ON i.product_id = p.id
WHERE p.is_archived = false
  AND p.search_vector @@ websearch_to_tsquery('simple'::regconfig, 'fabric')
ORDER BY p.created_at DESC, p.id DESC
LIMIT 21;
```

```
-- Real output from live Supabase instance (nghvaqzoteyslnwbuodc), 60 test rows:
Limit  (cost=5.29..5.29 rows=2 width=50) (actual time=0.740..0.743 rows=2 loops=1)
  Buffers: shared hit=7
  ->  Sort  (cost=5.29..5.29 rows=2 width=50) (actual time=0.739..0.741 rows=2 loops=1)
        Sort Key: p.created_at DESC, p.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=7
        ->  Hash Right Join  (cost=3.77..5.28 rows=2 width=50) (actual time=0.130..0.137 rows=2 loops=1)
              Hash Cond: (i.product_id = p.id)
              Buffers: shared hit=4
              ->  Seq Scan on inventory i  (cost=0.00..1.39 rows=39 width=20) (actual time=0.023..0.027 rows=60 loops=1)
                    Buffers: shared hit=1
              ->  Hash  (cost=3.75..3.75 rows=2 width=46) (actual time=0.039..0.040 rows=2 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 9kB
                    Buffers: shared hit=3
                    ->  Seq Scan on products p  (cost=0.00..3.75 rows=2 width=46) (actual time=0.026..0.035 rows=2 loops=1)
                          Filter: ((NOT is_archived) AND (search_vector @@ '''fabric'''::tsquery))
                          Rows Removed by Filter: 58
                          Buffers: shared hit=3
Planning Time: 1.919 ms
Execution Time: 0.904 ms
```

> **Why Seq Scan (not Bitmap Index Scan)?**
> With only 60 rows in this test instance, PostgreSQL's planner correctly chooses a sequential scan — it's cheaper than loading the GIN index for tiny tables. At production scale (>10,000 rows), the planner switches to `Bitmap Index Scan on idx_products_search` automatically. The GIN index exists and is used at scale.

---

## Part D — Written Answers

### D1: Scaling to 10M Users

**What breaks first, and why:**

1. **Connection count** (breaks first): Supabase free/pro tier has a connection limit. At 10M users, concurrent DB connections from API pods overwhelm the limit. Fix: PgBouncer connection pooler (Supabase already offers this on Pro).

2. **Full-text search** (breaks next): GIN indexes scale well to ~10M rows, but at 100M+ products with complex filters, query times degrade. Fix: Dedicated search engine (Typesense or Meilisearch) synced via Supabase Realtime CDC.

3. **FOR UPDATE lock contention** (at extreme load): If 10,000 customers simultaneously order the same hot product, the queue of waiting transactions grows. Fix: Move inventory tracking to Redis with atomic `DECRBY` Lua scripts. Redis can handle millions of atomic decrements/sec. Sync back to PostgreSQL asynchronously.

4. **Single write primary** (capacity limit): All writes go to one PostgreSQL primary. Fix: Read replicas for all product/store reads (horizontal read scaling). Sharding by seller if write volume explodes.

**Evolved architecture:**

```
Users → CDN (cached product catalog, static assets)
      → Load Balancer
      → API Pods (stateless, horizontal scale via Kubernetes)
        → Redis (idempotency TTL, session cache, hot product stock)
        → PgBouncer → PostgreSQL Primary (writes)
                    → PostgreSQL Read Replica × N (reads)
        → Typesense (dedicated FTS — synced via Supabase CDC)
        → BullMQ + Redis (async order event workers)
```

**Specific changes per feature:**
- Product listing: Redis cache with 60s TTL per filter combination, invalidated on product write
- Inventory: Redis `DECRBY` for real-time stock (Lua script for atomicity), async sync to PG every 5s
- Order events: BullMQ queue, dedicated worker pool — decoupled from request lifecycle
- Search: Typesense cluster with product index synced via `event_outbox` or direct CDC

### D2: What I Didn't Have Time To Do

With 2 more days, I would add:
1. **Durable notification history**: A `notifications` table so sellers see missed ORDER_CREATED events on next login. The outbox guarantees event persistence; the Realtime broadcast doesn't guarantee delivery.
2. **Load testing for concurrency**: Use `k6` or `autocannon` to verify that `FOR UPDATE` holds at 100+ concurrent order requests, and measure p99 latency under contention.
3. **Refresh token rotation**: Sessions expire with Supabase default TTL. Proper token refresh flow would improve UX.
4. **Stock replenishment API**: Sellers currently cannot add stock after initial creation. A `PATCH /products/:id/inventory` endpoint is needed.
5. **Rate limiting**: Per-IP and per-user rate limits on auth endpoints to prevent brute-force attacks.

### D3: AI & Library Usage

**AI assistance used:**
- Zod schema boilerplate (the `.strict()` insight was from the brief review)
- PostgreSQL migration syntax (trigger definitions, generated column syntax)
- This README structure and EXPLAIN output formatting
- OpenAPI YAML spec skeleton

**Written manually (all business logic):**
- The `FOR UPDATE` concurrency strategy and lock ordering reasoning
- The idempotency race condition analysis and fix (INSERT inside tx)
- All RLS policies and the service-layer authorization logic
- The transactional outbox design
- All SQL queries (especially the FTS + cursor pagination query)

**Libraries used and why:**
- `zod`: Schema validation — industry standard for TypeScript runtime validation
- `pg`: Raw PostgreSQL client — needed for explicit `BEGIN/COMMIT/FOR UPDATE` control that `supabase-js` doesn't expose
- `@supabase/supabase-js`: Auth + RLS-aware queries for non-transactional operations
- `express`: HTTP framework — familiar, well-documented, no magic
- `uuid`: For idempotency key validation

---

## Known Limitations

1. **Realtime delivery is not guaranteed**: `event_outbox` guarantees the event is written. Supabase Realtime `broadcast` is ephemeral — if the seller's client disconnects, they miss it. The event is not re-sent on reconnect.

2. **Raw pg Pool bypasses RLS**: Order placement uses direct PostgreSQL connection (no `auth.uid()`). Authorization enforced at service layer. See "RLS + pg Pool Tradeoff" section above.

3. **No refresh token rotation**: Sessions expire with the Supabase default TTL. Not built in this assessment scope.

4. **Test cleanup via auth.deleteUser**: Test data cleanup cascades through FK relationships. In a production scenario, soft-delete patterns would be preferred.

---

## Running the Concurrency Test

```bash
# Run Test 5 directly with verbose output (great for the video walkthrough)
npm run test:concurrency
```

Expected output:
```
✓ Test 5: Two simultaneous orders for the last item — exactly one succeeds

  ✅ Test 5 passed:
     - Customer A: 201
     - Customer B: 409
     - Orders in DB: 1
     - Stock in DB: 0
```
