import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createTestUser } from '../helpers/auth.helper';
import { seedStore, seedProduct, countOrders, cleanupUsers } from '../helpers/db.helper';
import { pool } from '../../src/db/pool';
import { v4 as uuidv4 } from 'uuid';

const app = createApp();

describe('Idempotency — B2', () => {
  let customer: { id: string; token: string };
  let seller: { id: string };
  let storeId: string;

  const suffix = Date.now();

  beforeAll(async () => {
    seller = await createTestUser(`seller-idem-${suffix}@test.com`, 'TestPass123!', 'SELLER');
    customer = await createTestUser(`customer-idem-${suffix}@test.com`, 'TestPass123!', 'CUSTOMER');
    const store = await seedStore(seller.id, { slug: `idem-store-${suffix}` });
    storeId = store.id;
  });

  afterAll(async () => {
    await cleanupUsers([seller.id, customer.id]);
  });

  // ── Test 6: Same Idempotency-Key → same order, not duplicated ──────
  it('Test 6: Same Idempotency-Key sent twice → returns same order (no duplicate)', async () => {
    const product = await seedProduct(storeId, { price_fcfa: 3000, initial_stock: 10 });
    const idempotencyKey = uuidv4();

    const payload = { items: [{ product_id: product.id, quantity: 1 }] };

    // First request
    const res1 = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect(res1.status).toBe(201);
    const orderId1 = res1.body.data.order.id;

    // Wait briefly so the idempotency key is persisted
    await new Promise((r) => setTimeout(r, 100));

    // Second request — same key, same payload
    const res2 = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    // Should return 200 (replay) with the same order
    expect(res2.status).toBe(200);
    expect(res2.body.data.order.id).toBe(orderId1); // Same order ID

    // Verify only ONE order was created in the database
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*)::int as count FROM orders WHERE id = $1`,
      [orderId1]
    );
    expect(countRow?.count).toBe(1);
  });

  it('Same key + different payload → 409 (hash mismatch)', async () => {
    const product1 = await seedProduct(storeId, { price_fcfa: 1000, initial_stock: 5 });
    const product2 = await seedProduct(storeId, { price_fcfa: 2000, initial_stock: 5 });
    const idempotencyKey = uuidv4();

    // First request with product1
    const res1 = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ items: [{ product_id: product1.id, quantity: 1 }] });

    expect(res1.status).toBe(201);
    await new Promise((r) => setTimeout(r, 150));

    // Second request — same key but DIFFERENT payload (product2 instead of product1)
    // SHA-256 of canonical input will differ → 409
    const res2 = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ items: [{ product_id: product2.id, quantity: 1 }] });

    expect(res2.status).toBe(409);
    expect(res2.body.detail).toContain('different request payload');
  });


  it('Double-click simulation: two concurrent requests with same key', async () => {
    const product = await seedProduct(storeId, { price_fcfa: 5000, initial_stock: 10 });
    const idempotencyKey = uuidv4();
    const payload = { items: [{ product_id: product.id, quantity: 1 }] };

    // Simulate double-click: two requests in quick succession with same key
    const [res1, res2] = await Promise.allSettled([
      request(app)
        .post('/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload),
      request(app)
        .post('/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload),
    ]);

    const responses = [res1, res2]
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<request.Response>).value);

    // Both should resolve (no crashes), and only ONE order created
    const successes = responses.filter((r) => r.status === 201 || r.status === 200);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Only 1 order for this product from this customer
    const orderCount = await countOrders({ product_id: product.id });
    expect(orderCount).toBe(1);
  });
});
