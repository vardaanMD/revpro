import { z } from "zod";

export const cartSchema = z.object({
  items: z.array(
    z.object({
      id: z.union([z.number(), z.string()]).optional(),
      product_id: z.union([z.number(), z.string()]).optional(),
      quantity: z.number().int().positive().max(1000),
      price: z.number().min(0),
      final_line_price: z.number().optional(),
    })
  ),
  total_price: z.number().min(0),
  currency: z.string().min(2).max(5).optional().default("USD"),
});

export type CartSchema = z.infer<typeof cartSchema>;
