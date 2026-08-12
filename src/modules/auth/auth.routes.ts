import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { z } from 'zod';
import { supabase, supabaseAdmin } from '../../config/supabase';
import { pool } from '../../db/pool';
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

      const { data: authData, error: signUpError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (signUpError) {
        if (signUpError.message.toLowerCase().includes('already registered') ||
            signUpError.message.toLowerCase().includes('already been registered')) {
          throw new ConflictError('An account with this email already exists');
        }
        throw new ValidationError(signUpError.message);
      }

      if (!authData.user) {
        throw new ValidationError('Registration failed — please try again');
      }

      // Insert profile via raw pool — FORCE RLS on profiles blocks PostgREST
      await pool.query(
        `INSERT INTO profiles (id, role, full_name) VALUES ($1, $2, $3)`,
        [authData.user.id, role, full_name]
      );

      res.status(201).json({
        data: {
          user: {
            id: authData.user.id,
            email: authData.user.email,
            role,
            full_name,
          },
          session: null, // Call POST /auth/login to obtain a token
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
