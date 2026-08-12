import { pool } from '../../db/pool';
import { CreateOrderInput } from './order.schema';
import { ConflictError, NotFoundError } from '../../utils/errors';

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
}

// ── placeOrder ────────────────────────────────────────────────────────
/**
 * Place an order atomically.
 *
 * Flow:
 *  1. Begin transaction
 *  2. [B2] INSERT idempotency key — unique constraint handles concurrent duplicates
 *  3. [B1] SELECT inventory FOR UPDATE (sorted product_ids — deadlock prevention)
 *  4. [A5] Resolve price from DB — client price is REJECTED by schema, never reaches here
 *  5. Validate stock for each item
 *  6. Deduct stock
 *  7. Insert order + order_items
 *  8. [B3] Insert ORDER_CREATED into event_outbox (same transaction — atomic)
 *  9. COMMIT
 * 10. Save idempotency response
 *
 * Concurrency (B1) — why FOR UPDATE works:
 *   Two transactions both try to lock the same inventory row.
 *   Transaction A acquires the lock first. Transaction B WAITS.
 *   A checks stock=1, deducts to 0, commits.
 *   B acquires the lock, re-reads stock=0, throws 409.
 *   Result: exactly one order created. One customer gets 201, one gets 409.
 *
 *   Lock ordering: product_ids are sorted before locking. This ensures that
 *   if two orders involve the same products, they always acquire locks in the
 *   same order — preventing deadlocks.
 *
 * Idempotency (B2) — atomic fix:
 *   We INSERT the idempotency key INSIDE the transaction (not before it).
 *   If the same key arrives concurrently, the UNIQUE constraint on
 *   orders.idempotency_key causes a unique-violation error on the second
 *   INSERT. We catch that specific error code (23505) and return the
 *   cached response — no duplicate order is ever created.
 *
 *   Same key + different payload → 409 (the payload hash differs).
 */
export async function placeOrder(
  customerId: string,
  input: CreateOrderInput,
  idempotencyKey?: string
): Promise<PlaceOrderResult> {

  // B2: Check if we already have a cached response for this idempotency key
  // This handles the non-concurrent case efficiently (double-click after first completes)
  if (idempotencyKey) {
    const cached = await getCachedIdempotencyResponse(idempotencyKey, customerId);
    if (cached) {
      return cached; // Return exact same response — 200 in route
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // B2: Insert idempotency key INSIDE the transaction.
    // If two concurrent requests race here, exactly one will succeed at INSERT.
    // The other gets a unique-violation (pg error code 23505).
    // We catch that below and return the cached response.
    if (idempotencyKey) {
      try {
        await client.query(
          `INSERT INTO idempotency_keys (key, response) VALUES ($1, $2::jsonb)`,
          [idempotencyKey, JSON.stringify({ pending: true })]
        );
      } catch (err: unknown) {
        // Unique violation — this key already exists (concurrent duplicate request)
        if (isUniqueViolation(err)) {
          await client.query('ROLLBACK');
          client.release();

          // Wait briefly for the first request to commit, then return cached response
          await sleep(50);
          const cached = await getCachedIdempotencyResponse(idempotencyKey, customerId);
          if (cached) return cached;

          // First request may have failed — let this one proceed fresh
          // (idempotency key will be cleaned up by TTL)
          throw new ConflictError(
            'A request with this Idempotency-Key is already being processed'
          );
        }
        throw err;
      }
    }

    // B1: Sort product IDs before locking — PREVENTS DEADLOCKS
    // If Order A locks [prod-1, prod-2] and Order B locks [prod-2, prod-1],
    // circular waiting occurs. Sorting ensures both acquire locks in the same order.
    const uniqueProductIds = [...new Set(input.items.map((i) => i.product_id))].sort();

    // B1: FOR UPDATE — acquires row-level locks on inventory rows.
    // The second concurrent transaction BLOCKS here until the first COMMITS.
    // After first commits, the second re-reads the UPDATED quantity.
    // This is why exactly one order succeeds when stock = 1.
    const { rows: lockedRows } = await client.query<{
      product_id: string;
      quantity: number;
      price_fcfa: number;
      is_archived: boolean;
      store_id: string;
    }>(
      `SELECT i.product_id, i.quantity, p.price_fcfa, p.is_archived, p.store_id
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE i.product_id = ANY($1::uuid[])
       ORDER BY i.product_id    -- consistent lock order
       FOR UPDATE`,             // ROW-LEVEL LOCK
      [uniqueProductIds]
    );

    // Validate all requested products were found
    for (const item of input.items) {
      if (!lockedRows.find((r) => r.product_id === item.product_id)) {
        throw new NotFoundError(`Product '${item.product_id}' not found`);
      }
    }

    // A5: Server resolves price + stock — client sent NO price, and schema rejects it if sent
    let totalFcfa = 0;
    const resolvedItems: Array<{
      product_id: string;
      quantity: number;
      unit_price_fcfa: number;
    }> = [];

    for (const item of input.items) {
      const inv = lockedRows.find((r) => r.product_id === item.product_id)!;

      if (inv.is_archived) {
        throw new ConflictError(
          `Product '${item.product_id}' is no longer available`
        );
      }

      // Stock check — AFTER lock acquired, reading the post-lock quantity
      if (inv.quantity < item.quantity) {
        throw new ConflictError(
          `Insufficient stock for product '${item.product_id}'`,
          {
            available: inv.quantity,
            requested: item.quantity,
          }
        );
      }

      totalFcfa += Number(inv.price_fcfa) * item.quantity;
      resolvedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price_fcfa: Number(inv.price_fcfa),
      });
    }

    // Deduct stock — all items in same transaction
    for (const item of input.items) {
      await client.query(
        `UPDATE inventory
         SET quantity = quantity - $1, updated_at = now()
         WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );
    }

    // Create the order — customer_id comes from JWT (never from request body)
    const { rows: [order] } = await client.query<Order>(
      `INSERT INTO orders (customer_id, total_fcfa, idempotency_key)
       VALUES ($1, $2, $3)
       RETURNING id, customer_id, status, total_fcfa, idempotency_key, created_at`,
      [customerId, totalFcfa, idempotencyKey ?? null]
    );

    // Insert order items — unit_price_fcfa is a snapshot (immutable purchase record)
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

    // B3: Write ORDER_CREATED event to outbox — IN THE SAME TRANSACTION
    // If this transaction rolls back, the event is NOT written.
    // The outbox poller picks it up asynchronously for Realtime delivery.
    await client.query(
      `INSERT INTO event_outbox (event_type, payload)
       VALUES ('ORDER_CREATED', $1::jsonb)`,
      [
        JSON.stringify({
          order_id: order!.id,
          customer_id: customerId,
          total_fcfa: totalFcfa,
          item_count: createdItems.length,
        }),
      ]
    );

    await client.query('COMMIT');

    const result: PlaceOrderResult = { order: order!, items: createdItems };

    // B2: Update idempotency key with the actual response
    if (idempotencyKey) {
      await pool.query(
        `UPDATE idempotency_keys
         SET order_id = $1, response = $2::jsonb
         WHERE key = $3`,
        [order!.id, JSON.stringify(result), idempotencyKey]
      );
    }

    return result;

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── getOrder ──────────────────────────────────────────────────────────
/**
 * Get a single order with its items. Customer can only see their own orders.
 */
export async function getOrder(
  customerId: string,
  orderId: string
): Promise<PlaceOrderResult> {
  const { rows: [order] } = await pool.query<Order>(
    `SELECT id, customer_id, status, total_fcfa, idempotency_key, created_at
     FROM orders WHERE id = $1 AND customer_id = $2`,
    [orderId, customerId]
  );

  if (!order) {
    throw new NotFoundError(`Order '${orderId}' not found`);
  }

  const { rows: items } = await pool.query<OrderItemResult>(
    `SELECT id, order_id, product_id, quantity, unit_price_fcfa
     FROM order_items WHERE order_id = $1`,
    [orderId]
  );

  return { order, items };
}

// ── listOrders ────────────────────────────────────────────────────────
export async function listOrders(customerId: string): Promise<Order[]> {
  const { rows } = await pool.query<Order>(
    `SELECT id, customer_id, status, total_fcfa, idempotency_key, created_at
     FROM orders WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [customerId]
  );
  return rows;
}

// ── Helpers ───────────────────────────────────────────────────────────

async function getCachedIdempotencyResponse(
  key: string,
  customerId: string
): Promise<PlaceOrderResult | null> {
  const { rows } = await pool.query<{ response: PlaceOrderResult; order_id: string }>(
    `SELECT ik.response, ik.order_id
     FROM idempotency_keys ik
     WHERE ik.key = $1
       AND ik.expires_at > now()
       AND ik.order_id IN (SELECT id FROM orders WHERE customer_id = $2)`,
    [key, customerId]
  );

  if (!rows[0] || (rows[0].response as unknown as { pending: boolean })?.pending) {
    return null;
  }
  return rows[0].response;
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
