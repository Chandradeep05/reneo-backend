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
  data: (Product & { stock: number })[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ── Coerce BIGINT fields to JS numbers ────────────────────────────────
// node-postgres returns BIGINT columns as JS strings to avoid precision
// loss on very large values. For FCFA amounts and stock counts we are
// well within the safe integer range, so Number() is safe.
function coerceProduct<T extends Partial<Product & { stock: number }>>(row: T): T {
  if (row.price_fcfa !== undefined) (row as Record<string, unknown>).price_fcfa = Number(row.price_fcfa);
  if (row.stock !== undefined)      (row as Record<string, unknown>).stock      = Number(row.stock);
  return row;
}

// ── Cursor encoding ───────────────────────────────────────────────────
interface CursorData {
  sort_value: string;
  created_at: string;
  id: string;
}

function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursor(cursor: string): CursorData | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorData;
  } catch {
    return null;
  }
}

// ── Store lookup helper ───────────────────────────────────────────────
// Uses raw pool (bypasses FORCE RLS on stores table).
async function getSellerStoreId(sellerId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM stores WHERE seller_id = $1 LIMIT 1`,
    [sellerId]
  );
  return rows[0]?.id ?? null;
}

// ── createProduct ─────────────────────────────────────────────────────
export async function createProduct(
  sellerId: string,
  input: CreateProductInput
): Promise<Product & { stock: number }> {
  const storeId = await getSellerStoreId(sellerId);
  if (!storeId) {
    throw new ForbiddenError('You must create a store before adding products');
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
    return coerceProduct({ ...product!, stock: input.initial_stock });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── listProducts ──────────────────────────────────────────────────────
export async function listProducts(query: ProductQuery): Promise<PaginatedProducts> {
  const { q, category, min_price, max_price, available, sort, limit, cursor } = query;

  const params: unknown[] = [];
  const conditions: string[] = ['p.is_archived = false'];

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
  if (available === 'true')  conditions.push(`COALESCE(i.quantity, 0) > 0`);
  if (available === 'false') conditions.push(`COALESCE(i.quantity, 0) = 0`);

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      if (sort === 'price_asc') {
        const pIdx = params.push(Number(decoded.sort_value));
        const dIdx = params.push(decoded.created_at);
        const iIdx = params.push(decoded.id);
        conditions.push(
          `(p.price_fcfa > $${pIdx} OR ` +
          `(p.price_fcfa = $${pIdx} AND (p.created_at < $${dIdx}::timestamptz OR ` +
          `(p.created_at = $${dIdx}::timestamptz AND p.id > $${iIdx}))))`
        );
      } else if (sort === 'price_desc') {
        const pIdx = params.push(Number(decoded.sort_value));
        const dIdx = params.push(decoded.created_at);
        const iIdx = params.push(decoded.id);
        conditions.push(
          `(p.price_fcfa < $${pIdx} OR ` +
          `(p.price_fcfa = $${pIdx} AND (p.created_at < $${dIdx}::timestamptz OR ` +
          `(p.created_at = $${dIdx}::timestamptz AND p.id > $${iIdx}))))`
        );
      } else if (sort === 'oldest') {
        params.push(decoded.sort_value, decoded.id);
        conditions.push(
          `(p.created_at > $${params.length - 1}::timestamptz OR ` +
          `(p.created_at = $${params.length - 1}::timestamptz AND p.id > $${params.length}))`
        );
      } else {
        params.push(decoded.sort_value, decoded.id);
        conditions.push(
          `(p.created_at < $${params.length - 1}::timestamptz OR ` +
          `(p.created_at = $${params.length - 1}::timestamptz AND p.id < $${params.length}))`
        );
      }
    }
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  let orderClause: string;
  if (sort === 'relevance' && q) {
    // Fix: params.indexOf(q) + 1 gives the correct $N index for the search term.
    // Single interpolation — NOT nested template literals (which produce $$N, a
    // Postgres dollar-quoted string delimiter, not a parameter placeholder).
    const qIdx = params.indexOf(q) + 1;
    orderClause = `ORDER BY ts_rank_cd(p.search_vector, websearch_to_tsquery('simple', $${qIdx})) DESC, p.created_at DESC, p.id DESC`;
  } else if (sort === 'price_asc') {
    orderClause = 'ORDER BY p.price_fcfa ASC, p.created_at DESC, p.id ASC';
  } else if (sort === 'price_desc') {
    orderClause = 'ORDER BY p.price_fcfa DESC, p.created_at DESC, p.id ASC';
  } else if (sort === 'oldest') {
    orderClause = 'ORDER BY p.created_at ASC, p.id ASC';
  } else {
    orderClause = 'ORDER BY p.created_at DESC, p.id DESC';
  }

  // For relevance sort, also SELECT the rank so we can encode it into the cursor.
  // This lets page 2 use (rank, created_at, id) for correct keyset pagination.
  const rankSelect = (sort === 'relevance' && q)
    ? `, ts_rank_cd(p.search_vector, websearch_to_tsquery('simple', $${params.indexOf(q) + 1})) AS rank`
    : '';

  params.push(limit + 1);
  const limitClause = `LIMIT $${params.length}`;

  const sql = `
    SELECT
      p.id, p.store_id, p.name, p.description,
      p.price_fcfa::bigint AS price_fcfa,
      p.category, p.is_archived, p.created_at, p.updated_at,
      COALESCE(i.quantity, 0)::int AS stock
      ${rankSelect}
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    ${whereClause}
    ${orderClause}
    ${limitClause}
  `;

  const { rows } = await pool.query<Product & { stock: number; rank?: number }>(sql, params);

  const hasMore = rows.length > limit;
  const data = (hasMore ? rows.slice(0, limit) : rows).map(coerceProduct);
  const lastItem = data[data.length - 1];

  let nextCursor: string | null = null;
  if (hasMore && lastItem) {
    let sortValue: string;
    if (sort === 'price_asc' || sort === 'price_desc') {
      sortValue = String(lastItem.price_fcfa);
    } else if (sort === 'relevance' && q) {
      // For relevance pagination, encode the actual ts_rank_cd value so that
      // page 2 correctly continues from the same ranking position.
      const rankRow = rows[data.length - 1];
      sortValue = String(rankRow?.rank ?? 0);
    } else {
      sortValue = lastItem.created_at;
    }
    nextCursor = encodeCursor({ sort_value: sortValue, created_at: lastItem.created_at, id: lastItem.id });
  }

  return { data, nextCursor, hasMore };
}

// ── getProduct ────────────────────────────────────────────────────────
export async function getProduct(productId: string): Promise<Product & { stock: number }> {
  const { rows } = await pool.query<Product & { stock: number }>(
    `SELECT p.id, p.store_id, p.name, p.description,
            p.price_fcfa::bigint AS price_fcfa,
            p.category, p.is_archived, p.created_at, p.updated_at,
            COALESCE(i.quantity, 0)::int AS stock
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.id = $1 AND p.is_archived = false`,
    [productId]
  );
  if (!rows[0]) throw new NotFoundError(`Product '${productId}' not found`);
  return coerceProduct(rows[0]);
}

// ── updateProduct ─────────────────────────────────────────────────────
export async function updateProduct(
  sellerId: string,
  productId: string,
  input: UpdateProductInput
): Promise<Product> {
  const storeId = await getSellerStoreId(sellerId);
  if (!storeId) throw new ForbiddenError('You do not own any store');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined)        { params.push(input.name);        updates.push(`name = $${params.length}`); }
  if (input.description !== undefined) { params.push(input.description); updates.push(`description = $${params.length}`); }
  if (input.price_fcfa !== undefined)  { params.push(input.price_fcfa);  updates.push(`price_fcfa = $${params.length}`); }
  if (input.category !== undefined)    { params.push(input.category);    updates.push(`category = $${params.length}`); }

  if (updates.length === 0) return getProduct(productId);

  params.push(productId);
  params.push(storeId);

  const { rows } = await pool.query<Product>(
    `UPDATE products
     SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND store_id = $${params.length} AND is_archived = false
     RETURNING id, store_id, name, description, price_fcfa::bigint AS price_fcfa,
               category, is_archived, created_at, updated_at`,
    params
  );

  if (!rows[0]) {
    // Distinguish: not found vs wrong store vs archived
    const { rows: [exists] } = await pool.query<{ store_id: string }>(
      `SELECT store_id FROM products WHERE id = $1`,
      [productId]
    );
    if (!exists) throw new NotFoundError(`Product '${productId}' not found`);
    if (exists.store_id !== storeId) throw new ForbiddenError("You cannot modify another seller's product");
    throw new ConflictError('Product is archived and cannot be updated');
  }
  return coerceProduct(rows[0]);
}

// ── archiveProduct ────────────────────────────────────────────────────
export async function archiveProduct(sellerId: string, productId: string): Promise<void> {
  const storeId = await getSellerStoreId(sellerId);
  if (!storeId) throw new ForbiddenError('You do not own any store');

  const { rows } = await pool.query(
    `UPDATE products SET is_archived = true
     WHERE id = $1 AND store_id = $2 AND is_archived = false RETURNING id`,
    [productId, storeId]
  );

  if (!rows[0]) {
    const { rows: [exists] } = await pool.query<{ store_id: string }>(
      `SELECT store_id FROM products WHERE id = $1`,
      [productId]
    );
    if (!exists) throw new NotFoundError(`Product '${productId}' not found`);
    if (exists.store_id !== storeId) throw new ForbiddenError("You cannot archive another seller's product");
    // Already archived — idempotent
  }
}
