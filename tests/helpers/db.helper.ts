import { pool } from '../../src/db/pool';
import { supabaseAdmin } from '../../src/config/supabase';

/**
 * Seed a store for a seller.
 */
export async function seedStore(sellerId: string, overrides: {
  name?: string;
  slug?: string;
} = {}): Promise<{ id: string; slug: string }> {
  const slug = overrides.slug ?? `test-store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { rows: [store] } = await pool.query(
    `INSERT INTO stores (seller_id, name, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (seller_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, slug`,
    [sellerId, overrides.name ?? 'Test Store', slug]
  );
  return store as { id: string; slug: string };
}

/**
 * Seed a product for a store.
 */
export async function seedProduct(storeId: string, overrides: {
  name?: string;
  price_fcfa?: number;
  category?: string;
  initial_stock?: number;
} = {}): Promise<{ id: string; price_fcfa: number; stock: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [product] } = await client.query(
      `INSERT INTO products (store_id, name, price_fcfa, category)
       VALUES ($1, $2, $3, $4)
       RETURNING id, price_fcfa`,
      [
        storeId,
        overrides.name ?? 'Test Product',
        overrides.price_fcfa ?? 1000,
        overrides.category ?? 'Test Category',
      ]
    );

    const stock = overrides.initial_stock ?? 10;
    await client.query(
      `INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)`,
      [product!.id, stock]
    );

    await client.query('COMMIT');
    return { id: product!.id, price_fcfa: product!.price_fcfa, stock };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get current stock for a product.
 */
export async function getStock(productId: string): Promise<number> {
  const { rows: [row] } = await pool.query(
    `SELECT quantity FROM inventory WHERE product_id = $1`,
    [productId]
  );
  return row?.quantity ?? 0;
}

/**
 * Count orders in DB.
 */
export async function countOrders(filters: { product_id?: string } = {}): Promise<number> {
  if (filters.product_id) {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(DISTINCT o.id)::int as count
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.product_id = $1`,
      [filters.product_id]
    );
    return row?.count ?? 0;
  }
  const { rows: [row] } = await pool.query(`SELECT COUNT(*)::int as count FROM orders`);
  return row?.count ?? 0;
}

/**
 * Clean up test data by user IDs (deletes orders, products, stores, profiles).
 * Relies on CASCADE FK constraints.
 */
export async function cleanupUsers(userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    // Cascades: profiles → stores → products → inventory
    //                            orders (via customer_id) → order_items
  }
}
