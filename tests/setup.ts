import { beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { stopOutboxPoller } from '../src/modules/notifications/notification.service';

/**
 * Global test setup.
 * Tests run against the real Supabase instance (integration tests).
 * Each test file is responsible for seeding and cleaning its own data.
 */

beforeAll(async () => {
  // Verify DB connection
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
});

afterAll(async () => {
  stopOutboxPoller();
  await pool.end();
});
