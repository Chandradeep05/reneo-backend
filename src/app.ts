import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { authRouter } from './modules/auth/auth.routes';
import { productRouter } from './modules/products/product.routes';
import { orderRouter } from './modules/orders/order.routes';
import { storeRouter } from './modules/stores/store.routes';
import { errorMiddleware } from './middleware/error.middleware';

/**
 * Creates and configures the Express app.
 * Exported as a factory (no listen call) so tests can import it directly
 * via supertest without starting a real server.
 */
export function createApp(): express.Application {
  const app = express();

  // ── Core Middleware ─────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // CORS — explicit origin, not wildcard
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    })
  );

  // Request ID — every request gets a unique ID for tracing
  app.use((req, res, next) => {
    const reqId = req.headers['x-request-id'] as string ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    req.headers['x-request-id'] = reqId;
    res.setHeader('x-request-id', reqId);
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────
  app.use('/auth', authRouter);
  app.use('/products', productRouter);
  app.use('/orders', orderRouter);
  app.use('/stores', storeRouter);

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 404 handler for unmatched routes
  app.use((_req, res) => {
    res.status(404).json({
      type: 'https://reneo.app/errors/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'The requested endpoint does not exist',
    });
  });

  // ── Error Middleware (MUST be last) ─────────────────────────────────
  app.use(errorMiddleware);

  return app;
}
