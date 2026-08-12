import { supabase, supabaseAdmin } from '../../src/config/supabase';

interface TestUser {
  id: string;
  email: string;
  token: string;
  role: 'SELLER' | 'CUSTOMER';
}

/**
 * Creates a test user via Supabase Auth + inserts profile.
 * Automatically cleans up in test teardown when deleteTestUser is called.
 */
export async function createTestUser(
  email: string,
  password: string,
  role: 'SELLER' | 'CUSTOMER',
  fullName?: string
): Promise<TestUser> {
  // Sign up
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`Test signup failed: ${error?.message}`);

  // Insert profile (service role bypasses RLS)
  const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
    id: data.user.id,
    role,
    full_name: fullName ?? `Test ${role} ${Date.now()}`,
  });
  if (profileError) throw new Error(`Test profile failed: ${profileError.message}`);

  // Sign in to get access token
  const { data: session, error: loginError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (loginError || !session.session) {
    throw new Error(`Test login failed: ${loginError?.message}`);
  }

  return {
    id: data.user.id,
    email,
    token: session.session.access_token,
    role,
  };
}

/**
 * Delete a test user and their profile (cascades via FK).
 */
export async function deleteTestUser(userId: string): Promise<void> {
  await supabaseAdmin.auth.admin.deleteUser(userId);
}

/**
 * Get a fresh access token for an existing test user.
 */
export async function getToken(email: string, password: string): Promise<string> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Login failed: ${error?.message}`);
  return data.session.access_token;
}
