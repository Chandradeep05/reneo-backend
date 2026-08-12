import { z } from 'zod';

/**
 * Order item schema — STRICT mode.
 *
 * Verdict fix: The brief says "your API should REJECT [a price field] if one appears."
 * Using .strict() means any unknown field (including "price", "price_fcfa", etc.)
 * will cause Zod to throw a ZodError → 400 Bad Request.
 *
 * The order payload intentionally has NO price field.
 * Price is always resolved server-side from the database.
 */
const OrderItemSchema = z
  .object({
    product_id: z.string().uuid('product_id must be a valid UUID'),
    quantity: z
      .number({ required_error: 'quantity is required' })
      .int('Quantity must be a whole number')
      .positive('Quantity must be at least 1'),
  })
  .strict(); // Rejects any extra fields — e.g., "price" → 400

export const CreateOrderSchema = z
  .object({
    items: z
      .array(OrderItemSchema)
      .min(1, 'Order must contain at least one item')
      .max(50, 'Order cannot contain more than 50 items')
      .refine(
        (items) => new Set(items.map((i) => i.product_id)).size === items.length,
        {
          message:
            'Duplicate product_id detected. Combine quantities into a single item per product.',
        }
      ),
  })
  .strict(); // Reject unknown top-level fields too

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type OrderItem = z.infer<typeof OrderItemSchema>;
