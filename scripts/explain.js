/**
 * Run EXPLAIN ANALYZE on the core queries against the live Supabase instance.
 * Requires DATABASE_URL to be set in .env.
 *
 * Usage: node scripts/explain.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  try {
    // Run EXPLAIN ANALYZE on the core FTS + pagination query (A4)
    const ftsResult = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT p.id, p.name, p.price_fcfa,
             COALESCE(i.quantity, 0) AS stock
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.is_archived = false
        AND p.search_vector @@ websearch_to_tsquery('simple'::regconfig, 'fabric')
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 21
    `);

    console.log('=== FTS + Pagination EXPLAIN ===');
    ftsResult.rows.forEach(r => console.log(r['QUERY PLAN']));
    console.log('');

    // Run EXPLAIN ANALYZE on the inventory lock query (B1)
    const lockResult = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT i.product_id, i.quantity, p.price_fcfa, p.is_archived
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE i.product_id = ANY(ARRAY[]::uuid[])
      ORDER BY i.product_id
      FOR UPDATE
    `);

    console.log('=== Inventory FOR UPDATE EXPLAIN ===');
    lockResult.rows.forEach(r => console.log(r['QUERY PLAN']));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

run();
