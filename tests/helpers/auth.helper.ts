import { supabaseAdmin } from '../../src/config/supabase';

export interface TestUser {
  id: string;
  email: string;
  token: string;
  role: 'SELLER' | 'CUSTOMER';
}

/**
 * Creates a test user via the Supabase Admin API.
 *
 * We use `supabaseAdmin.auth.admin.createUser` instead of `signUp` because:
 *  - `signUp` requires email confirmation by default (blocks login in tests)
 *  - Admin `createUser` with `email_confirm: true` bypasses the confirmation step
 *
 * This is valid for integration tests — we're testing our own API logic,
 * not Supabase's email confirmation flow.
 */
export async function createTestUser(
  email: string,
  password: string,
  role: 'SELLER' | 'CUSTOMER',
  fullName?: string
): Promise<TestUser> {
  // Create user via admin (skips email confirmation)
  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // bypass confirmation — required for tests to be able to sign in
  });

  if (createError || !created.user) {
    throw new Error(`Test user creation failed: ${createError?.message}`);
  }

  const userId = created.user.id;

  // Insert profile (service role bypasses RLS)
  const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
    id: userId,
    role,
    full_name: fullName ?? `Test ${role} ${Date.now()}`,
  });

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Test profile creation failed: ${profileError.message}`);
  }

  // Sign in to get access token
  const { data: session, error: loginError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });

  // Fall back to signInWithPassword (works since email is confirmed)
  const { createClient } = await import('@supabase/supabase-js');

  // Load env manually since this runs before the app
  const supabaseUrl = process.env['SUPABASE_URL']!;
  const anonKey = process.env['SUPABASE_ANON_KEY']!;
  const client = createClient(supabaseUrl, anonKey);

  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
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
 * Delete a test user (cascades profile via FK).
 */
export async function deleteTestUser(userId: string): Promise<void> {
  await supabaseAdmin.auth.admin.deleteUser(userId);
}

/**
 * Get a fresh access token for a test user.
 */
export async function getToken(email: string, password: string): Promise<string> {
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(process.env['SUPABASE_URL']!, process.env['SUPABASE_ANON_KEY']!);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Login failed: ${error?.message}`);
  return data.session.access_token;
}
