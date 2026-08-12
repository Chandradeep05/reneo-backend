import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireCustomer } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { CreateOrderSchema } from './order.schema';
import { placeOrder, getOrder, listOrders } from './order.service';

export const orderRouter = Router();

// ── POST /orders ──────────────────────────────────────────────────────
// Customer only: place an order
// Accepts optional Idempotency-Key header for B2
orderRouter.post(
  '/',
  requireAuth,
  requireCustomer,
  validate(CreateOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      // Check if this is a cached idempotency response
      const isIdempotentReturn =
        idempotencyKey !== undefined &&
        req.headers['idempotency-key'] !== undefined;

      const result = await placeOrder(req.user!.id, req.body, idempotencyKey);

      // Return 200 for idempotent replay, 201 for new order
      // We detect replay by checking if the order's created_at is > 1s ago
      const isReplay = isIdempotentReturn &&
        new Date(result.order.created_at).getTime() < Date.now() - 1000;

      res.status(isReplay ? 200 : 201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /orders ───────────────────────────────────────────────────────
// Customer only: list own orders
orderRouter.get(
  '/',
  requireAuth,
  requireCustomer,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orders = await listOrders(req.user!.id);
      res.status(200).json({ data: orders });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /orders/:id ───────────────────────────────────────────────────
// Customer only: get own order detail
orderRouter.get(
  '/:id',
  requireAuth,
  requireCustomer,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getOrder(req.user!.id, req.params['id']!);
      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);
