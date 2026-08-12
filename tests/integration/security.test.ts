import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createTestUser } from '../helpers/auth.helper';
import { seedStore, seedProduct, cleanupUsers } from '../helpers/db.helper';

const app = createApp();

describe('Security — Privilege Escalation & Injection — Tests 9, 12, 13, 15', () => {
  let sellerA: { id: string; token: string };
  let sellerB: { id: string; token: string };
  let customer: { id: string; token: string };
  let storeAId: string;

  const suffix = Date.now();

  beforeAll(async () => {
    sellerA = await createTestUser(`seller-a-sec-${suffix}@test.com`, 'TestPass123!', 'SELLER');
    sellerB = await createTestUser(`seller-b-sec-${suffix}@test.com`, 'TestPass123!', 'SELLER');
    customer = await createTestUser(`customer-sec-${suffix}@test.com`, 'TestPass123!', 'CUSTOMER');
    const store = await seedStore(sellerA.id, { slug: `sec-store-a-${suffix}` });
    storeAId = store.id;
    await seedStore(sellerB.id, { slug: `sec-store-b-${suffix}` });
  });

  afterAll(async () => {
    await cleanupUsers([sellerA.id, sellerB.id, customer.id]);
  });

  // ── Test 9: Invalid JWT → 401 ─────────────────────────────────────
  it('Test 12: Invalid JWT → 401', async () => {
    const res = await request(app)
      .get('/products')
      .set('Authorization', 'Bearer this.is.invalid');
    expect(res.status).toBe(401);
  });

  it('Test 13: No auth header → 401', async () => {
    const res = await request(app).get('/products');
    expect(res.status).toBe(401);
  });

  it('Test 9: CUSTOMER cannot access seller-only endpoint → 403', async () => {
    const product = await seedProduct(storeAId, { initial_stock: 5 });

    const res = await request(app)
      .patch(`/products/${product.id}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ name: 'Hacked Name' });

    expect(res.status).toBe(403);
  });

  // ── SQL Injection in search query ─────────────────────────────────
  it('Test 8: SQL injection in search query → safe (no crash, no data leak)', async () => {
    // Attempt SQL injection via the q parameter
    const injectionPayload = "'; DROP TABLE products; --";

    const res = await request(app)
      .get(`/products?q=${encodeURIComponent(injectionPayload)}`)
      .set('Authorization', `Bearer ${customer.token}`);

    // Should return 200 with empty results (parameterized query is safe)
    // OR 400 if Zod validation rejects the payload
    expect([200, 400]).toContain(res.status);

    // The products table must still exist (no drop occurred)
    const checkRes = await request(app)
      .get('/products?limit=1')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(checkRes.status).toBe(200);
  });

  it('Test 8b: SQL injection in product ID param → 404 (parameterized, no error)', async () => {
    const res = await request(app)
      .get(`/products/1' OR '1'='1`)
      .set('Authorization', `Bearer ${customer.token}`);

    // Parameterized queries prevent injection — returns 404 not 500
    expect([400, 404]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });

  // ── Test 7: RLS — Cross-seller product modification ───────────────
  it('Test 7: Seller B cannot modify Seller A product via API (RLS + service layer)', async () => {
    const product = await seedProduct(storeAId, { name: 'A Only Product', initial_stock: 3 });

    // Seller B via API
    const apiRes = await request(app)
      .patch(`/products/${product.id}`)
      .set('Authorization', `Bearer ${sellerB.token}`)
      .send({ name: 'Compromised Name' });

    expect(apiRes.status).toBe(403);

    // Verify product name was NOT changed
    const getRes = await request(app)
      .get(`/products/${product.id}`)
      .set('Authorization', `Bearer ${customer.token}`);

    expect(getRes.body.data.name).toBe('A Only Product');
  });

  it('Seller cannot delete another seller\'s product → 403', async () => {
    const product = await seedProduct(storeAId, { initial_stock: 2 });

    const res = await request(app)
      .delete(`/products/${product.id}`)
      .set('Authorization', `Bearer ${sellerB.token}`);

    expect(res.status).toBe(403);
  });

  it('Customer cannot delete a product → 403', async () => {
    const product = await seedProduct(storeAId, { initial_stock: 2 });

    const res = await request(app)
      .delete(`/products/${product.id}`)
      .set('Authorization', `Bearer ${customer.token}`);

    expect(res.status).toBe(403);
  });

  it('Unknown fields in request body are rejected (strict validation)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({
        email: 'test@test.com',
        password: 'password123',
        role: 'ADMIN', // Unknown field — strict schema
        is_admin: true,
      });

    // Strict schema rejects unknown fields
    expect(res.status).toBe(400);
  });
});
