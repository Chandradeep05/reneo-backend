import { supabaseAdmin } from '../../src/config/supabase';
import { pool } from '../../src/db/pool';

export interface TestUser {
  id: string;
  email: string;
  token: string;
  role: 'SELLER' | 'CUSTOMER';
}

/**
 * Creates a test user via the Supabase Admin API.
 *
 * Why admin.createUser instead of signUp:
 *   signUp requires email confirmation → blocks sign-in in tests.
 *   Admin createUser with email_confirm: true skips that step.
 *
 * Why raw pool for profile insert:
 *   FORCE ROW LEVEL SECURITY applies even to the service_role JWT when
 *   using the REST/PostgREST interface — no INSERT policy exists on profiles
 *   (intentionally, to prevent profile spoofing). The raw pg.Pool connects
 *   as the postgres superuser which is exempt from RLS entirely.
 */
export async function createTestUser(
  email: string,
  password: string,
  role: 'SELLER' | 'CUSTOMER',
  fullName?: string
): Promise<TestUser> {
  // 1. Create auth user (admin API — no email confirmation needed)
  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    throw new Error(`Test user creation failed: ${createError?.message}`);
  }

  const userId = created.user.id;
  const name = fullName ?? `Test ${role} ${Date.now()}`;

  // 2. Insert profile via raw pool — postgres superuser bypasses FORCE RLS
  try {
    await pool.query(
      `INSERT INTO profiles (id, role, full_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name`,
      [userId, role, name]
    );
  } catch (err) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Test profile creation failed: ${(err as Error).message}`);
  }

  // 3. Sign in to get JWT
  const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Test sign-in failed: ${signInError?.message}`);
  }

  return {
    id: userId,
    email,
    token: signInData.session.access_token,
    role,
  };
}

/**
 * Delete test users by ID. Cascades profile via FK.
 */
export async function cleanupUsers(userIds: string[]): Promise<void> {
  for (const id of userIds) {
    if (!id) continue;
    try {
      await supabaseAdmin.auth.admin.deleteUser(id);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Delete a single test user.
 */
export async function deleteTestUser(userId: string): Promise<void> {
  await supabaseAdmin.auth.admin.deleteUser(userId);
}

/**
 * Get a fresh access token for a test user.
 */
export async function getToken(email: string, password: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Login failed: ${error?.message}`);
  return data.session.access_token;
}
