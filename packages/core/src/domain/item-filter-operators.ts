/**
 * Payload filter operators (plan §8.2). Kept dependency-free so client
 * components (dashboard filter form) can import them; `item-filter.ts`
 * re-exports them.
 */
export const PAYLOAD_FILTER_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "exists",
] as const
export type PayloadFilterOperator = (typeof PAYLOAD_FILTER_OPERATORS)[number]
