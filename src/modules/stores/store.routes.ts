import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { requireAuth, requireSeller } from '../../middleware/auth.middleware';
import { z } from 'zod';
import { supabaseAdmin } from '../../config/supabase';
import { pool } from '../../db/pool';
import { ConflictError, NotFoundError } from '../../utils/errors';

export const storeRouter = Router();

const CreateStoreSchema = z
  .object({
    name: z.string().min(1).max(255),
    slug: z
      .string()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Slug must be lowercase alphanumeric with hyphens'),
    description: z.string().max(5000).optional(),
  })
  .strict();

// ── POST /stores ──────────────────────────────────────────────────────
// Seller only: create their store (one per seller)
storeRouter.post(
  '/',
  requireAuth,
  requireSeller,
  validate(CreateStoreSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, slug, description } = req.body as z.infer<typeof CreateStoreSchema>;
      const sellerId = req.user!.id;

      const { data: existing } = await supabaseAdmin
        .from('stores')
        .select('id')
        .eq('seller_id', sellerId)
        .single();

      if (existing) {
        throw new ConflictError('You already have a store');
      }

      const { rows: [store] } = await pool.query(
        `INSERT INTO stores (seller_id, name, slug, description)
         VALUES ($1, $2, $3, $4)
         RETURNING id, seller_id, name, slug, description, is_active, created_at`,
        [sellerId, name, slug, description ?? null]
      );

      res.status(201).json({ data: store });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /stores/:slug ─────────────────────────────────────────────────
// Public: store profile + active products
storeRouter.get(
  '/:slug',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows: [store] } = await pool.query(
        `SELECT id, seller_id, name, slug, description, is_active, created_at
         FROM stores WHERE slug = $1 AND is_active = true`,
        [req.params['slug']]
      );

      if (!store) throw new NotFoundError(`Store '${req.params['slug']}' not found`);

      const { rows: products } = await pool.query(
        `SELECT p.id, p.name, p.description, p.price_fcfa, p.category, p.created_at,
                COALESCE(i.quantity, 0) AS stock
         FROM products p
         LEFT JOIN inventory i ON i.product_id = p.id
         WHERE p.store_id = $1 AND p.is_archived = false
         ORDER BY p.created_at DESC
         LIMIT 50`,
        [store.id]
      );

      res.status(200).json({ data: { store, products } });
    } catch (err) {
      next(err);
    }
  }
);
