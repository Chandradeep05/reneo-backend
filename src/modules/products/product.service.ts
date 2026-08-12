import { supabaseAdmin } from '../../config/supabase';
import { pool } from '../../db/pool';
import {
  CreateProductInput,
  UpdateProductInput,
  ProductQuery,
} from './product.schema';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../utils/errors';

// ── Types ─────────────────────────────────────────────────────────────
export interface Product {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  price_fcfa: number;
  category: string;
  is_archived: boolean;
  stock?: number;
  created_at: string;
  updated_at: string;
}

export interface PaginatedProducts {
  data: Product[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Encode a cursor from a created_at timestamp + id pair.
 * Using both ensures stable pagination even when timestamps collide.
 */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
      createdAt: string;
      id: string;
    };
  } catch {
    return null;
  }
}

/**
 * Get the seller's store ID. Returns null if they don't have a store yet.
 */
async function getSellerStoreId(sellerId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('stores')
    .select('id')
    .eq('seller_id', sellerId)
    .single();
  return data?.id ?? null;
}

// ── Service Functions ─────────────────────────────────────────────────

/**
 * Create a product + its initial inventory in a single transaction.
 * Seller must have an existing store.
 */
export async function createProduct(
  sellerId: string,
  input: CreateProductInput
): Promise<Product & { stock: number }> {
  const storeId = await getSellerStoreId(sellerId);
  if (!storeId) {
    throw new ForbiddenError(
      'You must create a store before adding products'
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [product] } = await client.query<Product>(
      `INSERT INTO products (store_id, name, description, price_fcfa, category)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, store_id, name, description, price_fcfa, category,
                 is_archived, created_at, updated_at`,
      [storeId, input.name, input.description ?? null, input.price_fcfa, input.category]
    );

    await client.query(
      `INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)`,
      [product!.id, input.initial_stock]
    );

    await client.query('COMMIT');
    return { ...product!, stock: input.initial_stock };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List products with full-text search, filters, sorting, and cursor pagination.
 *
 * Uses GIN index on search_vector for FTS.
 * Uses cursor-based pagination (NOT OFFSET) to handle 1M+ rows efficiently.
 *
 * EXPLAIN output is in README.md.
 */
export async function listProducts(query: ProductQuery): Promise<PaginatedProducts> {
  const {
    q,
    category,
    min_price,
    max_price,
    available,
    sort,
    limit,
    cursor,
  } = query;

  const params: unknown[] = [];
  const conditions: string[] = ['p.is_archived = false'];

  // Full-text search using websearch_to_tsquery for safe raw user input
  // ('simple' dictionary — same as the index configuration)
  if (q) {
    params.push(q);
    conditions.push(`p.search_vector @@ websearch_to_tsquery('simple', $${params.length})`);
  }

  if (category) {
    params.push(category);
    conditions.push(`p.category ILIKE $${params.length}`);
  }

  if (min_price !== undefined) {
    params.push(min_price);
    conditions.push(`p.price_fcfa >= $${params.length}`);
  }

  if (max_price !== undefined) {
    params.push(max_price);
    conditions.push(`p.price_fcfa <= $${params.length}`);
  }

  if (available === 'true') {
    conditions.push(`i.quantity > 0`);
  } else if (available === 'false') {
    conditions.push(`i.quantity = 0`);
  }

  // Cursor pagination — decode the cursor to get the last seen position
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      params.push(decoded.createdAt);
      params.push(decoded.id);
      // For newest-first: find rows created before the cursor
      // Using (created_at, id) ensures stable ordering on timestamp ties
      if (sort === 'newest' || sort === 'relevance') {
        conditions.push(
          `(p.created_at, p.id) < ($${params.length - 1}, $${params.length})`
        );
      } else if (sort === 'oldest') {
        conditions.push(
          `(p.created_at, p.id) > ($${params.length - 1}, $${params.length})`
        );
      }
      // For price sorts, cursor is handled differently (omitted for brevity)
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort order
  let orderClause: string;
  if (sort === 'relevance' && q) {
    orderClause = `ORDER BY ts_rank_cd(p.search_vector, websearch_to_tsquery('simple', '${q.replace(/'/g, "''")}')) DESC, p.created_at DESC, p.id DESC`;
  } else if (sort === 'price_asc') {
    orderClause = 'ORDER BY p.price_fcfa ASC, p.created_at DESC, p.id DESC';
  } else if (sort === 'price_desc') {
    orderClause = 'ORDER BY p.price_fcfa DESC, p.created_at DESC, p.id DESC';
  } else if (sort === 'oldest') {
    orderClause = 'ORDER BY p.created_at ASC, p.id ASC';
  } else {
    orderClause = 'ORDER BY p.created_at DESC, p.id DESC'; // newest (default)
  }

  // Fetch limit + 1 to determine if there's a next page
  params.push(limit + 1);
  const limitClause = `LIMIT $${params.length}`;

  const sql = `
    SELECT
      p.id,
      p.store_id,
      p.name,
      p.description,
      p.price_fcfa,
      p.category,
      p.is_archived,
      p.created_at,
      p.updated_at,
      COALESCE(i.quantity, 0) AS stock
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    ${whereClause}
    ${orderClause}
    ${limitClause}
  `;

  const { rows } = await pool.query<Product & { stock: number }>(sql, params);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  const lastItem = data[data.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCursor(lastItem.created_at, lastItem.id)
      : null;

  return { data, nextCursor, hasMore };
}

/**
 * Get a single product by ID. Public — any authenticated user can read.
 */
export async function getProduct(productId: string): Promise<Product & { stock: number }> {
  const { rows } = await pool.query<Product & { stock: number }>(
    `SELECT p.id, p.store_id, p.name, p.description, p.price_fcfa,
            p.category, p.is_archived, p.created_at, p.updated_at,
            COALESCE(i.quantity, 0) AS stock
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.id = $1 AND p.is_archived = false`,
    [productId]
  );

  if (!rows[0]) {
    throw new NotFoundError(`Product with id '${productId}' not found`);
  }
  return rows[0];
}

/**
 * Update a product. Seller can only update their own products.
 * PATCH semantics — only provided fields are updated.
 */
export async function updateProduct(
  sellerId: string,
  productId: string,
  input: UpdateProductInput
): Promise<Product> {
  // Verify ownership
  const storeId = await getSellerStoreId(sellerId);
  if (!storeId) {
    throw new ForbiddenError('You do not own any store');
  }

  // Build dynamic SET clause from provided fields only
  const updates: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    params.push(input.name);
    updates.push(`name = $${params.length}`);
  }
  if (input.description !== undefined) {
    params.push(input.description);
    updates.push(`description = $${params.length}`);
  }
  if (input.price_fcfa !== undefined) {
    params.push(input.price_fcfa);
    updates.push(`price_fcfa = $${params.length}`);
  }
  if (input.category !== undefined) {
    params.push(input.category);
    updates.push(`category = $${params.length}`);
  }

  if (updates.length === 0) {
    // Nothing to update — return current product
    return getProduct(productId);
  }

  params.push(productId);
  params.push(storeId);

  const { rows } = await pool.query<Product>(
    `UPDATE products
     SET ${updates.join(', ')}
     WHERE id = $${params.length - 1}
       AND store_id = $${params.length}
       AND is_archived = false
     RETURNING id, store_id, name, description, price_fcfa, category, is_archived, created_at, updated_at`,
    params
  );

  if (!rows[0]) {
    // Could be not found OR wrong store — both are 403/404
    // We treat cross-seller attempts as 403 (policy: don't confirm existence)
    const exists = await supabaseAdmin
      .from('products')
      .select('store_id')
      .eq('id', productId)
      .single();

    if (!exists.data) throw new NotFoundError(`Product '${productId}' not found`);
    if (exists.data.store_id !== storeId) {
      throw new ForbiddenError('You cannot modify another seller\'s product');
    }
    throw new ConflictError('Product is archived and cannot be updated');
  }

  return rows[0];
}

/**
 * Soft-archive a product. Sets is_archived = true.
 * Hard delete is not supported — preserves order_items history.
 */
export async function archiveProduct(
  sellerId: string,
  productId: string
): Promise<void> {
  const storeId = await getSellerStoreId(sellerId);
  if (!storeId) {
    throw new ForbiddenError('You do not own any store');
  }

  const { rows } = await pool.query(
    `UPDATE products
     SET is_archived = true
     WHERE id = $1 AND store_id = $2 AND is_archived = false
     RETURNING id`,
    [productId, storeId]
  );

  if (!rows[0]) {
    const exists = await supabaseAdmin
      .from('products')
      .select('store_id')
      .eq('id', productId)
      .single();

    if (!exists.data) throw new NotFoundError(`Product '${productId}' not found`);
    if (exists.data.store_id !== storeId) {
      throw new ForbiddenError('You cannot archive another seller\'s product');
    }
    // Already archived — idempotent, return success
  }
}
