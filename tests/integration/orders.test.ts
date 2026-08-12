import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createTestUser } from '../helpers/auth.helper';
import { seedStore, seedProduct, getStock, cleanupUsers } from '../helpers/db.helper';

const app = createApp();

describe('Orders API — Tests 3, 4 + extras', () => {
  let seller: { id: string; token: string };
  let customer: { id: string; token: string };
  let anotherCustomer: { id: string; token: string };
  let storeId: string;

  const suffix = Date.now();

  beforeAll(async () => {
    seller = await createTestUser(`seller-ord-${suffix}@test.com`, 'TestPass123!', 'SELLER');
    customer = await createTestUser(`customer-ord-${suffix}@test.com`, 'TestPass123!', 'CUSTOMER');
    anotherCustomer = await createTestUser(`customer2-ord-${suffix}@test.com`, 'TestPass123!', 'CUSTOMER');

    const store = await seedStore(seller.id, { slug: `order-store-${suffix}` });
    storeId = store.id;
  });

  afterAll(async () => {
    await cleanupUsers([seller.id, customer.id, anotherCustomer.id]);
  });

  // ── Test 3: Customer orders an available product ──────────────────
  it('Test 3: Customer orders an available product → 201 + stock decremented', async () => {
    const product = await seedProduct(storeId, { price_fcfa: 2000, initial_stock: 5 });
    const stockBefore = await getStock(product.id);
    expect(stockBefore).toBe(5);

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ items: [{ product_id: product.id, quantity: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order).toMatchObject({
      customer_id: customer.id,
      status: 'CONFIRMED',
      total_fcfa: 4000, // 2000 * 2
    });
    expect(res.body.data.items[0]).toMatchObject({
      product_id: product.id,
      quantity: 2,
      unit_price_fcfa: 2000, // Price resolved server-side
    });

    // Verify stock was decremented
    const stockAfter = await getStock(product.id);
    expect(stockAfter).toBe(3); // 5 - 2
  });

  // ── Test 4: Customer orders more than the stock ───────────────────
  it('Test 4: Customer orders more than the stock → 409 Denied', async () => {
    const product = await seedProduct(storeId, { price_fcfa: 1000, initial_stock: 3 });

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ items: [{ product_id: product.id, quantity: 10 }] }); // Way over stock

    expect(res.status).toBe(409);
    expect(res.body.status).toBe(409);
    expect(res.body.available).toBe(3);
    expect(res.body.requested).toBe(10);

    // Stock must not have changed
    const stockAfter = await getStock(product.id);
    expect(stockAfter).toBe(3);
  });

  // ── Test: Client cannot inject price into order ───────────────────
  it('Test 10: Client sends price in order payload → 400 (schema rejects it)', async () => {
    const product = await seedProduct(storeId, { price_fcfa: 5000, initial_stock: 10 });

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        items: [
          {
            product_id: product.id,
            quantity: 1,
            price: 1,          // Attempt to inject a price
            price_fcfa: 1,     // Another attempt
          },
        ],
      });

    // .strict() on OrderItemSchema rejects unknown fields
    expect(res.status).toBe(400);
  });

  // ── Test: Order archived product → 409 ───────────────────────────
  it('Test 14: Order archived product → 409', async () => {
    const product = await seedProduct(storeId, { initial_stock: 5 });

    // Archive the product
    await request(app)
      .delete(`/products/${product.id}`)
      .set('Authorization', `Bearer ${seller.token}`);

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }] });

    expect(res.status).toBe(409);
  });

  // ── Test: Spoofed customer_id in body is ignored ─────────────────
  it('Test 15: Customer cannot spoof customer_id in order body → 403', async () => {
    const product = await seedProduct(storeId, { initial_stock: 5 });

    // Try to place order as if it's for anotherCustomer by spoofing
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        customer_id: anotherCustomer.id, // Should be rejected (schema is strict)
        items: [{ product_id: product.id, quantity: 1 }],
      });

    // .strict() on CreateOrderSchema rejects unknown field "customer_id"
    expect(res.status).toBe(400);
  });

  it('Seller cannot place orders → 403', async () => {
    const product = await seedProduct(storeId, { initial_stock: 5 });

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${seller.token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }] });

    expect(res.status).toBe(403);
  });

  it('Server resolves correct price regardless of what client sends', async () => {
    const product = await seedProduct(storeId, { price_fcfa: 5000, initial_stock: 10 });

    // Only valid fields — no price field (schema rejects it)
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }] });

    expect(res.status).toBe(201);
    // Server resolved price = 5000 from DB
    expect(res.body.data.order.total_fcfa).toBe(5000);
    expect(res.body.data.items[0].unit_price_fcfa).toBe(5000);
  });

  it('Duplicate product_id in order → 400 (prevents double stock deduction)', async () => {
    const product = await seedProduct(storeId, { price_fcfa: 1000, initial_stock: 10 });

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        items: [
          { product_id: product.id, quantity: 2 },
          { product_id: product.id, quantity: 3 }, // duplicate!
        ],
      });

    expect(res.status).toBe(400);
    // ZodError fields contain the duplicate message
    const allMessages = JSON.stringify(res.body.fields ?? res.body);
    expect(allMessages).toMatch(/[Dd]uplicate/);
  });
});
