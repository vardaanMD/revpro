/**
 * Cart Pro V3 analytics event schema (server type).
 * Matches engine output exactly. Do not add fields.
 */
export interface AnalyticsEventV3 {
  id: string;
  name: string;
  payload: Record<string, any>;
  timestamp: number;
  cartSnapshot: {
    itemCount: number;
    subtotal: number;
  };
  sessionId: string;
}
