import { Database } from "./database.ts";
import type { CheckoutSession } from "./stripe.ts";

/** Price of the full plan, as in the plans() SQL function. */
export const fullPlan = { price: 4900, currency: "eur" };

/**
 * Switches the wedding of a paid session to the full plan. Idempotent: the
 * webhook and the panel's check may both arrive, and Stripe may resend the
 * same webhook.
 */
export async function applyPaidSession(server: Database, session: CheckoutSession): Promise<void> {
  if (session.payment_status !== "paid") return;
  // only full-plan sessions, paid in full
  const amount = session.amount_total;
  if (session.currency !== fullPlan.currency || typeof amount !== "number" || amount < fullPlan.price) {
    console.warn(`Payment ignored, unexpected amount: ${session.id}`);
    return;
  }
  const weddingId = session.client_reference_id ?? session.metadata?.wedding_id;
  if (!weddingId) return;

  await server.update(`weddings?id=eq.${encodeURIComponent(weddingId)}&plan=eq.free`, {
    plan: "full",
    payment: { session: session.id, amount, currency: session.currency, date: new Date().toISOString() },
  });
}
