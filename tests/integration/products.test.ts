import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createTestUser, deleteTestUser } from '../helpers/auth.helper';
import { seedStore, seedProduct, getStock, countOrders, cleanupUsers } from '../helpers/db.helper';

const app = createApp();

describe('Products API — Tests 1 & 2 + extra', () => {
  let sellerA: { id: string; email: string; token: string };
  let sellerB: { id: string; email: string; token: string };
  let customer: { id: string; email: string; token: string };
  let storeA: { id: string };
  let storeB: { id: string };

  const suffix = Date.now();

  beforeAll(async () => {
    // Create two sellers and a customer
    sellerA = await createTestUser(`seller-a-${suffix}@test.com`, 'TestPass123!', 'SELLER', 'Seller A');
    sellerB = await createTestUser(`seller-b-${suffix}@test.com`, 'TestPass123!', 'SELLER', 'Seller B');
    customer = await createTestUser(`customer-${suffix}@test.com`, 'TestPass123!', 'CUSTOMER', 'Test Customer');

    storeA = await seedStore(sellerA.id, { slug: `store-a-${suffix}` });
    storeB = await seedStore(sellerB.id, { slug: `store-b-${suffix}` });
  });

  afterAll(async () => {
    await cleanupUsers([sellerA.id, sellerB.id, customer.id]);
  });

  // ── Test 1: Seller A creates a product ─────────────────────────────
  it('Test 1: Seller A creates a product → 201 Success', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${sellerA.token}`)
      .send({
        name: 'West African Fabric',
        description: 'Premium quality fabric',
        price_fcfa: 5000,
        category: 'Clothing',
        initial_stock: 20,
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'West African Fabric',
      price_fcfa: 5000,
      category: 'Clothing',
    });
    expect(res.body.data.store_id).toBe(storeA.id);
    expect(res.body.data.stock).toBe(20);
  });

  // ── Test 2: Seller B attempts to modify Seller A's product ──────────
  it('Test 2: Seller B attempts to modify Seller A\'s product → 403 Denied', async () => {
    // First, create a product as Seller A
    const createRes = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${sellerA.token}`)
      .send({
        name: 'Seller A Product',
        price_fcfa: 2500,
        category: 'Electronics',
        initial_stock: 5,
      });

    expect(createRes.status).toBe(201);
    const productId = createRes.body.data.id;

    // Now Seller B tries to modify it
    const modifyRes = await request(app)
      .patch(`/products/${productId}`)
      .set('Authorization', `Bearer ${sellerB.token}`)
      .send({ price_fcfa: 100 });

    expect(modifyRes.status).toBe(403);
    expect(modifyRes.body.status).toBe(403);
    expect(modifyRes.body.type).toContain('forbidden');
  });

  it('Customer cannot create a product → 403', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        name: 'Unauthorized Product',
        price_fcfa: 100,
        category: 'Test',
        initial_stock: 1,
      });

    expect(res.status).toBe(403);
  });

  it('Missing auth → 401', async () => {
    const res = await request(app).get('/products');
    expect(res.status).toBe(401);
  });

  it('Invalid JWT → 401', async () => {
    const res = await request(app)
      .get('/products')
      .set('Authorization', 'Bearer invalid.jwt.token');
    expect(res.status).toBe(401);
  });

  it('Product list returns paginated results', async () => {
    // Seed product for seller A to list
    await seedProduct(storeA.id, { name: 'Paginated Product', price_fcfa: 999 });

    const res = await request(app)
      .get('/products?limit=10')
      .set('Authorization', `Bearer ${customer.token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('hasMore');
    expect(res.body).toHaveProperty('nextCursor');
  });

  it('Seller deletes their own product → 204', async () => {
    const createRes = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${sellerA.token}`)
      .send({
        name: 'To Be Archived',
        price_fcfa: 1000,
        category: 'Test',
        initial_stock: 0,
      });

    expect(createRes.status).toBe(201);
    const productId = createRes.body.data.id;

    const deleteRes = await request(app)
      .delete(`/products/${productId}`)
      .set('Authorization', `Bearer ${sellerA.token}`);

    expect(deleteRes.status).toBe(204);

    // Verify it's no longer accessible publicly
    const getRes = await request(app)
      .get(`/products/${productId}`)
      .set('Authorization', `Bearer ${customer.token}`);
    expect(getRes.status).toBe(404);
  });
});
