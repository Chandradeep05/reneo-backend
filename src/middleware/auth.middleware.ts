import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { pool } from '../db/pool';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

export type UserRole = 'SELLER' | 'CUSTOMER';

declare global {
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
 * Extract and verify the JWT from Authorization: Bearer <token>.
 * Uses supabaseAdmin.auth.getUser (service_role) for reliable server-side
 * token verification. Profile role fetched via raw pool (FORCE RLS bypass).
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

    const token = authHeader.slice(7);

    // Verify token with service_role client — validates signature + expiry
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Fetch role via raw pool — FORCE RLS on profiles blocks PostgREST
    const { rows } = await pool.query<{ role: UserRole }>(
      `SELECT role FROM profiles WHERE id = $1`,
      [user.id]
    );

    if (!rows[0]) {
      throw new UnauthorizedError('User profile not found — please re-register');
    }

    req.user = {
      id: user.id,
      role: rows[0].role,
      email: user.email ?? '',
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Guard: only SELLER role allowed. Must be used AFTER requireAuth.
 */
export function requireSeller(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user) { next(new UnauthorizedError()); return; }
  if (req.user.role !== 'SELLER') {
    next(new ForbiddenError('This endpoint is restricted to sellers'));
    return;
  }
  next();
}

/**
 * Guard: only CUSTOMER role allowed. Must be used AFTER requireAuth.
 */
export function requireCustomer(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user) { next(new UnauthorizedError()); return; }
  if (req.user.role !== 'CUSTOMER') {
    next(new ForbiddenError('This endpoint is restricted to customers'));
    return;
  }
  next();
}
