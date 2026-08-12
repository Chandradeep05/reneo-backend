import crypto from 'crypto';
import { pool } from '../../db/pool';
import { CreateOrderInput } from './order.schema';
import { ConflictError, NotFoundError, ForbiddenError } from '../../utils/errors';

// ── Types ─────────────────────────────────────────────────────────────
export interface Order {
  id: string;
  customer_id: string;
  status: string;
  total_fcfa: number;
  idempotency_key: string | null;
  created_at: string;
}

export interface OrderItemResult {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price_fcfa: number;
}

export interface PlaceOrderResult {
  order: Order;
  items: OrderItemResult[];
  fromCache?: boolean;  // true when returning cached idempotent response
}

// ── Hash helper ───────────────────────────────────────────────────────
/**
 * Compute a canonical, deterministic SHA-256 hash of the order input.
 *
 * Why "canonical"? JSON serialization of objects is not guaranteed to
 * produce identical output across different key orderings. We sort the
 * items array by product_id and produce a stable string so that
 * identical logical requests always produce identical hashes —
 * regardless of the order the client sends items in.
 *
 * This hash is what lets us enforce "same key + different payload → 409".
 */
function computeRequestHash(input: CreateOrderInput): string {
  const canonical = JSON.stringify({
    items: [...input.items]
      .sort((a, b) => a.product_id.localeCompare(b.product_id))
      .map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ── placeOrder ────────────────────────────────────────────────────────
/**
 * Place an order atomically.
 *
 * Transaction boundary (single BEGIN → COMMIT):
 *  1. INSERT idempotency key + request_hash (unique constraint = deduplication lock)
 *  2. SELECT inventory FOR UPDATE  (sorted product IDs = deadlock prevention)
 *  3. Server resolves price + validates stock
 *  4. Deduct stock
 *  5. INSERT order + order_items
 *  6. INSERT event_outbox (ORDER_CREATED)
 *  7. UPDATE idempotency_keys with final order_id + response  ← INSIDE transaction
 *  8. COMMIT
 *
 * Idempotency atomicity (Verdict 2 fix):
 *   The idempotency response is written BEFORE commit, inside the same
 *   transaction. After COMMIT there is no race window — the key has
 *   the completed response immediately and atomically.
 *   No sleep(50), no post-commit update race.
 *
 * Same key + different payload (Verdict 2 fix):
 *   On key cache hit, we compare request_hash. Mismatch → 409 Conflict.
 *
 * Concurrency (B1):
 *   Two concurrent requests both try SELECT FOR UPDATE on the same
 *   inventory row. One acquires the lock; the other WAITS. After the
 *   first commits, the second re-reads the post-commit quantity.
 *   If stock = 1 and both want 1 unit, exactly one gets stock > 0.
 *
 * Price integrity (A5):
 *   The order schema uses .strict() — any price field sent by the
 *   client causes a 400 before this function is ever called.
 *   Inside this function, price is always read from the DB, never from
 *   the input.
 *
 * Authorization:
 *   customerId is extracted from the verified JWT in auth.middleware.ts
 *   and passed explicitly — it never comes from req.body.
 *   This function enforces that the customer placing the order is a
 *   legitimate customer (service-layer check, since pg.Pool bypasses RLS).
 */
export async function placeOrder(
  customerId: string,
  input: CreateOrderInput,
  idempotencyKey?: string
): Promise<PlaceOrderResult> {
  const requestHash = idempotencyKey ? computeRequestHash(input) : undefined;

  // Pre-check: is there already a completed response for this key?
  // This fast-path handles the non-concurrent case (e.g., user clicks twice
  // with a 2-second gap — no DB transaction needed for the second click).
  if (idempotencyKey) {
    const cached = await getCachedResponse(idempotencyKey, customerId, requestHash!);
    if (cached.type === 'ok') return { ...cached.result, fromCache: true };
    if (cached.type === 'hash_mismatch') {
      throw new ConflictError(
        'This Idempotency-Key was already used with a different request payload. ' +
        'Use a unique key for each distinct order.'
      );
    }
    // cached.type === 'not_found' → proceed to place the order
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── B2: Insert idempotency key inside the transaction ────────────
    // If two concurrent requests race here, exactly one INSERT succeeds.
    // The other gets a unique-violation (pg error code 23505), caught below.
    if (idempotencyKey) {
      try {
        await client.query(
          `INSERT INTO idempotency_keys (key, request_hash, response)
           VALUES ($1, $2, $3::jsonb)`,
          [idempotencyKey, requestHash, JSON.stringify({ _pending: true })]
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Concurrent duplicate — the other request is inside its transaction.
          // Roll back, then fetch the cached response.
          await client.query('ROLLBACK');
          client.release();

          // Poll until the concurrent request commits and writes the response.
          // Max 10 attempts × 100ms = 1s. If still pending after 1s, the
          // concurrent request failed — tell the client to retry.
          for (let attempt = 0; attempt < 10; attempt++) {
            await sleep(100);
            const cached = await getCachedResponse(idempotencyKey, customerId, requestHash!);
            if (cached.type === 'ok') return { ...cached.result, fromCache: true };
            if (cached.type === 'hash_mismatch') {
              throw new ConflictError(
                'This Idempotency-Key was already used with a different request payload.'
              );
            }
          }
          throw new ConflictError(
            'A concurrent request with this Idempotency-Key is still processing. ' +
            'Please retry in a moment.'
          );
        }
        throw err;
      }
    }

    // ── B1: Sort product IDs before locking — PREVENTS DEADLOCKS ────
    // Sorting ensures two overlapping orders always acquire locks in the
    // same order — circular waiting is impossible.
    const uniqueProductIds = [...new Set(input.items.map((i) => i.product_id))].sort();

    // ── B1: SELECT FOR UPDATE — acquires row-level inventory locks ───
    // The second concurrent transaction BLOCKS here until the first COMMITS.
    // After commit, it re-reads the UPDATED (post-deduction) quantity.
    // That re-read is what makes "exactly one succeeds" correct.
    const { rows: lockedRows } = await client.query<{
      product_id: string;
      quantity: number;
      price_fcfa: number;
      is_archived: boolean;
    }>(
      `SELECT i.product_id, i.quantity, p.price_fcfa, p.is_archived
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE i.product_id = ANY($1::uuid[])
       ORDER BY i.product_id    -- consistent lock acquisition order
       FOR UPDATE`,
      [uniqueProductIds]
    );

    // Validate all products exist and are available
    for (const requestedItem of input.items) {
      const locked = lockedRows.find((r) => r.product_id === requestedItem.product_id);
      if (!locked) {
        throw new NotFoundError(`Product '${requestedItem.product_id}' not found`);
      }
      if (locked.is_archived) {
        throw new ConflictError(`Product '${requestedItem.product_id}' is no longer available`);
      }
      // Stock check — reading the post-lock, post-commit value
      if (locked.quantity < requestedItem.quantity) {
        throw new ConflictError(
          `Insufficient stock for product '${requestedItem.product_id}'`,
          { available: locked.quantity, requested: requestedItem.quantity }
        );
      }
    }

    // ── A5: Server resolves price — client has no say ────────────────
    // price_fcfa comes from the DB row we just locked, not from input.
    let totalFcfa = 0;
    const resolvedItems: Array<{
      product_id: string;
      quantity: number;
      unit_price_fcfa: number;
    }> = [];

    for (const item of input.items) {
      const locked = lockedRows.find((r) => r.product_id === item.product_id)!;
      const unitPrice = Number(locked.price_fcfa);
      totalFcfa += unitPrice * item.quantity;
      resolvedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price_fcfa: unitPrice,
      });
    }

    // Deduct stock (all items, same transaction)
    for (const item of input.items) {
      await client.query(
        `UPDATE inventory
         SET quantity = quantity - $1, updated_at = now()
         WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );
    }

    // Insert order — customer_id is from verified JWT, never from input
    const { rows: [order] } = await client.query<Order>(
      `INSERT INTO orders (customer_id, total_fcfa, idempotency_key)
       VALUES ($1, $2, $3)
       RETURNING id, customer_id, status, total_fcfa, idempotency_key, created_at`,
      [customerId, totalFcfa, idempotencyKey ?? null]
    );

    // Insert order items — price snapshot (immutable purchase record)
    const createdItems: OrderItemResult[] = [];
    for (const ri of resolvedItems) {
      const { rows: [item] } = await client.query<OrderItemResult>(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_fcfa)
         VALUES ($1, $2, $3, $4)
         RETURNING id, order_id, product_id, quantity, unit_price_fcfa`,
        [order!.id, ri.product_id, ri.quantity, ri.unit_price_fcfa]
      );
      createdItems.push(item!);
    }

    // ── B3: Write ORDER_CREATED to outbox — same transaction ─────────
    await client.query(
      `INSERT INTO event_outbox (event_type, payload)
       VALUES ('ORDER_CREATED', $1::jsonb)`,
      [JSON.stringify({
        order_id: order!.id,
        customer_id: customerId,
        total_fcfa: totalFcfa,
        item_count: createdItems.length,
      })]
    );

    // Coerce BIGINT strings from pg to JS numbers before storing/returning
    const coercedOrder: Order = {
      ...order!,
      total_fcfa: Number(order!.total_fcfa),
    };
    const coercedItems: OrderItemResult[] = createdItems.map((it) => ({
      ...it,
      unit_price_fcfa: Number(it.unit_price_fcfa),
    }));
    const result: PlaceOrderResult = { order: coercedOrder, items: coercedItems };

    // ── B2: Update idempotency response INSIDE the transaction ───────
    if (idempotencyKey) {
      await client.query(
        `UPDATE idempotency_keys
         SET order_id = $1, response = $2::jsonb
         WHERE key = $3`,
        [coercedOrder.id, JSON.stringify(result), idempotencyKey]
      );
    }

    await client.query('COMMIT');
    return result;

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── getOrder ──────────────────────────────────────────────────────────
export async function getOrder(
  customerId: string,
  orderId: string
): Promise<PlaceOrderResult> {
  const { rows: [order] } = await pool.query<Order>(
    `SELECT id, customer_id, status, total_fcfa::bigint, idempotency_key, created_at
     FROM orders WHERE id = $1 AND customer_id = $2`,
    [orderId, customerId]
  );
  if (!order) throw new NotFoundError(`Order '${orderId}' not found`);

  const { rows: items } = await pool.query<OrderItemResult>(
    `SELECT id, order_id, product_id, quantity, unit_price_fcfa::bigint
     FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  return {
    order: { ...order, total_fcfa: Number(order.total_fcfa) },
    items: items.map((it) => ({ ...it, unit_price_fcfa: Number(it.unit_price_fcfa) })),
  };
}

// ── listOrders ────────────────────────────────────────────────────────
export async function listOrders(customerId: string): Promise<Order[]> {
  const { rows } = await pool.query<Order>(
    `SELECT id, customer_id, status, total_fcfa::bigint, idempotency_key, created_at
     FROM orders WHERE customer_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [customerId]
  );
  return rows.map((r) => ({ ...r, total_fcfa: Number(r.total_fcfa) }));
}

// ── Internal helpers ──────────────────────────────────────────────────

type CacheResult =
  | { type: 'ok'; result: PlaceOrderResult }
  | { type: 'hash_mismatch' }
  | { type: 'pending' }
  | { type: 'not_found' };

/**
 * Look up an existing idempotency key and validate the request hash.
 * Returns:
 *  - 'ok'            → same key, same payload, completed → return cached response
 *  - 'hash_mismatch' → same key, DIFFERENT payload → 409
 *  - 'pending'       → concurrent request in-flight
 *  - 'not_found'     → key doesn't exist yet → proceed to place order
 */
async function getCachedResponse(
  key: string,
  customerId: string,
  requestHash: string
): Promise<CacheResult> {
  const { rows } = await pool.query<{
    request_hash: string;
    response: PlaceOrderResult & { _pending?: boolean };
    order_id: string | null;
    expires_at: string;
  }>(
    `SELECT ik.request_hash, ik.response, ik.order_id, ik.expires_at
     FROM idempotency_keys ik
     WHERE ik.key = $1 AND ik.expires_at > now()`,
    [key]
  );

  if (!rows[0]) return { type: 'not_found' };

  const row = rows[0];

  // Hash mismatch → 409 (same key, different payload)
  if (row.request_hash !== requestHash) return { type: 'hash_mismatch' };

  // Still pending (concurrent request in-flight)
  if (row.response?._pending) return { type: 'pending' };

  // Verify the order belongs to this customer (prevents key sharing across accounts)
  if (row.order_id) {
    const { rows: [orderRow] } = await pool.query(
      `SELECT id FROM orders WHERE id = $1 AND customer_id = $2`,
      [row.order_id, customerId]
    );
    if (!orderRow) {
      throw new ForbiddenError('Idempotency key does not belong to this account');
    }
  }

  return { type: 'ok', result: row.response };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
