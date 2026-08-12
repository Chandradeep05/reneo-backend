import { z } from 'zod';

// ── Create Product ────────────────────────────────────────────────────
export const CreateProductSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(5000).optional(),
  price_fcfa: z
    .number({ required_error: 'price_fcfa is required' })
    .int('Price must be a whole number of FCFA')
    .positive('Price must be greater than 0'),
  category: z.string().min(1, 'Category is required').max(100),
  initial_stock: z.number().int().min(0).default(0),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;

// ── Update Product (PATCH — all fields optional) ──────────────────────
export const UpdateProductSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).optional().nullable(),
  price_fcfa: z.number().int().positive().optional(),
  category: z.string().min(1).max(100).optional(),
});

export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

// ── Query Products (list + search) ────────────────────────────────────
export const ProductQuerySchema = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  min_price: z.coerce.number().int().min(0).optional(),
  max_price: z.coerce.number().int().min(0).optional(),
  available: z.enum(['true', 'false']).optional(),
  sort: z
    .enum(['newest', 'oldest', 'price_asc', 'price_desc', 'relevance'])
    .default('newest'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(), // base64-encoded cursor
});

export type ProductQuery = z.infer<typeof ProductQuerySchema>;
