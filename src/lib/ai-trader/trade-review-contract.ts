import { z } from "zod";

/** User-facing review only; provider reasoning and raw responses are excluded. */
export const TradeReviewSchema = z.object({
  what_worked: z.string().trim().min(1).max(2000),
  what_failed: z.string().trim().min(1).max(2000),
  review_text: z.string().trim().min(1).max(4000),
  hypothesis: z.string().trim().min(1).max(2000),
  confidence: z.number().int().min(1).max(5),
}).strict();

export type TradeReview = z.infer<typeof TradeReviewSchema>;

export function parseTradeReview(value: unknown): TradeReview {
  return TradeReviewSchema.parse(value);
}
