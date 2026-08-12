import { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodSchema } from 'zod';

type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Factory that creates a validation middleware for a given Zod schema and target.
 * On validation failure: throws ZodError which the error middleware formats as 400.
 * On success: replaces req[target] with the parsed (coerced + trimmed) data.
 */
export function validate(
  schema: ZodSchema,
  target: ValidationTarget = 'body'
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[target]);
      // Replace with parsed data (coercions applied, defaults filled)
      (req as unknown as Record<string, unknown>)[target] = parsed;
      next();
    } catch (err) {
      next(err); // ZodError → error middleware formats as 400
    }
  };
}

/**
 * Validate request body AND reject any extra unknown fields.
 * Used for sensitive endpoints like order placement where we must
 * ensure no extraneous fields (like "price") sneak in.
 */
export function validateStrict(schema: ZodSchema): RequestHandler {
  return validate(schema.pipe(z.object({}).passthrough()), 'body');
}
