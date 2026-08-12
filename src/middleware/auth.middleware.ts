import { Request, Response, NextFunction } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

export type UserRole = 'SELLER' | 'CUSTOMER';

// Extend Express Request to carry authenticated user info
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: UserRole;
        email: string;
      };
    }
  }
}

/**
 * Extract and verify the JWT from Authorization: Bearer <token>
 * Attaches req.user = { id, role, email } on success.
 * Returns 401 if token is missing, invalid, or expired.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authorization header with Bearer token is required');
    }

    const token = authHeader.slice(7); // Remove "Bearer "

    // Verify token with Supabase — this validates signature + expiry
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Fetch the user's role from the profiles table
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      throw new UnauthorizedError('User profile not found — please re-register');
    }

    req.user = {
      id: user.id,
      role: profile.role as UserRole,
      email: user.email ?? '',
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Guard: only SELLER role allowed.
 * Must be used AFTER requireAuth.
 */
export function requireSeller(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  if (req.user.role !== 'SELLER') {
    next(new ForbiddenError('This endpoint is restricted to sellers'));
    return;
  }
  next();
}

/**
 * Guard: only CUSTOMER role allowed.
 * Must be used AFTER requireAuth.
 */
export function requireCustomer(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  if (req.user.role !== 'CUSTOMER') {
    next(new ForbiddenError('This endpoint is restricted to customers'));
    return;
  }
  next();
}
