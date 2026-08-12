import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireSeller } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  CreateProductSchema,
  UpdateProductSchema,
  ProductQuerySchema,
} from './product.schema';
import {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  archiveProduct,
} from './product.service';

export const productRouter = Router();

// ── POST /products ────────────────────────────────────────────────────
// Seller only: create a new product with initial inventory
productRouter.post(
  '/',
  requireAuth,
  requireSeller,
  validate(CreateProductSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await createProduct(req.user!.id, req.body);
      res.status(201).json({ data: product });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /products ─────────────────────────────────────────────────────
// Public (authenticated): list with search, filters, cursor pagination
productRouter.get(
  '/',
  requireAuth,
  validate(ProductQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listProducts(req.query as unknown as Parameters<typeof listProducts>[0]);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /products/:id ─────────────────────────────────────────────────
// Public (authenticated): get a single product
productRouter.get(
  '/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await getProduct(req.params['id']!);
      res.status(200).json({ data: product });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /products/:id ───────────────────────────────────────────────
// Seller only: update own product (partial update)
productRouter.patch(
  '/:id',
  requireAuth,
  requireSeller,
  validate(UpdateProductSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await updateProduct(req.user!.id, req.params['id']!, req.body);
      res.status(200).json({ data: product });
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /products/:id ──────────────────────────────────────────────
// Seller only: soft-archive product (preserves order history)
productRouter.delete(
  '/:id',
  requireAuth,
  requireSeller,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await archiveProduct(req.user!.id, req.params['id']!);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
