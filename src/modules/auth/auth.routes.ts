import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { z } from 'zod';
import { supabase, supabaseAdmin } from '../../config/supabase';
import { ConflictError, UnauthorizedError, ValidationError } from '../../utils/errors';

export const authRouter = Router();

const RegisterSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    full_name: z.string().min(1).max(255),
    role: z.enum(['SELLER', 'CUSTOMER']),
  })
  .strict();

const LoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

// ── POST /auth/register ───────────────────────────────────────────────
authRouter.post(
  '/register',
  validate(RegisterSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, full_name, role } = req.body as z.infer<typeof RegisterSchema>;

      // Create auth user
      const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (signUpError) {
        if (signUpError.message.toLowerCase().includes('already registered')) {
          throw new ConflictError('An account with this email already exists');
        }
        throw new ValidationError(signUpError.message);
      }

      if (!authData.user) {
        throw new ValidationError('Registration failed — please try again');
      }

      // Create profile using service role (bypasses RLS for initial insert)
      const { error: profileError } = await supabaseAdmin.from('profiles').insert({
        id: authData.user.id,
        role,
        full_name,
      });

      if (profileError) {
        // Cleanup: delete the auth user if profile creation fails
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
        throw new Error(`Profile creation failed: ${profileError.message}`);
      }

      res.status(201).json({
        data: {
          user: {
            id: authData.user.id,
            email: authData.user.email,
            role,
            full_name,
          },
          session: authData.session,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /auth/login ──────────────────────────────────────────────────
authRouter.post(
  '/login',
  validate(LoginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as z.infer<typeof LoginSchema>;

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error || !data.session) {
        throw new UnauthorizedError('Invalid email or password');
      }

      // Fetch role for response
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role, full_name')
        .eq('id', data.user.id)
        .single();

      res.status(200).json({
        data: {
          user: {
            id: data.user.id,
            email: data.user.email,
            role: profile?.role,
            full_name: profile?.full_name,
          },
          session: {
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_at: data.session.expires_at,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /auth/logout ─────────────────────────────────────────────────
authRouter.post(
  '/logout',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers.authorization?.slice(7);
      if (token) {
        await supabase.auth.signOut();
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
