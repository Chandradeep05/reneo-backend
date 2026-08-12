import { Pool } from 'pg';
import { env } from '../config/env';

/**
 * Raw PostgreSQL connection pool for operations that require
 * explicit transaction control (BEGIN / COMMIT / ROLLBACK).
 *
 * Used exclusively for: order placement with FOR UPDATE stock locking.
 *
 * ⚠️  IMPORTANT — RLS tradeoff:
 * This pool connects using the DATABASE_URL (typically the postgres superuser
 * or a high-privilege role). RLS policies based on auth.uid() do NOT apply
 * to queries executed through this pool.
 *
 * Authorization is therefore enforced at the SERVICE LAYER:
 *   - customerId is extracted from the verified JWT (auth.middleware.ts)
 *     and passed explicitly into the transaction — never from req.body
 *   - Ownership checks for products are done via JOINs against stores/profiles
 *     inside the transaction itself
 *
 * This is a documented, intentional tradeoff: raw pg gives us the explicit
 * transaction control needed for atomic FOR UPDATE locking, which supabase-js
 * does not expose. The service layer enforces the same invariants that RLS would.
 *
 * Reference: See README.md "RLS and pg Pool" section.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected pg pool error:', err.message);
});
