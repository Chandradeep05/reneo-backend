import { Request, Response, NextFunction } from 'express';
import { AppError, ValidationError } from '../utils/errors';
import { env } from '../config/env';
import { ZodError } from 'zod';

/**
 * Global error handler — must be the LAST middleware registered.
 * Produces RFC 7807 Problem Details responses on all error paths.
 *
 * Shape:
 * {
 *   type:      "https://reneo.app/errors/<errorType>",
 *   title:     "Human-readable error title",
 *   status:    404,
 *   detail:    "Specific description of what went wrong",
 *   instance:  "/path/to/resource",
 *   requestId: "uuid"
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req.headers['x-request-id'] as string) || 'unknown';
  const instance = req.originalUrl;

  // Handle Zod validation errors from the validate middleware
  if (err instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || 'root';
      if (!fields[key]) fields[key] = [];
      fields[key].push(issue.message);
    }
    res.status(400).json({
      type: 'https://reneo.app/errors/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'One or more fields failed validation',
      instance,
      requestId,
      fields,
    });
    return;
  }

  // Handle our typed AppError hierarchy
  if (err instanceof AppError) {
    const body: Record<string, unknown> = {
      type: `https://reneo.app/errors/${err.errorType}`,
      title: err.title,
      status: err.statusCode,
      detail: err.detail,
      instance,
      requestId,
    };
    if (err instanceof ValidationError && err.fields) {
      body['fields'] = err.fields;
    }
    if (err.extra) {
      Object.assign(body, err.extra);
    }
    res.status(err.statusCode).json(body);
    return;
  }

  // Unknown/unexpected error
  // Never leak stack traces or internal details in production
  const detail =
    env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message || 'An unexpected error occurred';

  if (env.NODE_ENV !== 'test') {
    console.error(`[${requestId}] Unhandled error:`, err);
  }

  res.status(500).json({
    type: 'https://reneo.app/errors/internal-error',
    title: 'Internal Server Error',
    status: 500,
    detail,
    instance,
    requestId,
  });
}
