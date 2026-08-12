import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Anon client — used for auth operations (signIn, signUp, getUser).
 * Respects RLS policies using the user's JWT.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Service role client — bypasses RLS. Used ONLY for:
 * - Profile creation after signup (needs to insert into profiles table)
 * - Admin operations that require elevated access
 *
 * NEVER expose this client or the service role key to any client response.
 */
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
