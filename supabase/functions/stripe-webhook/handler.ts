import { Database } from "../_shared/database.ts";
import { HttpError, json } from "../_shared/http.ts";
import { applyPaidSession } from "../_shared/payments.ts";
import { InvalidSignature, readWebhook } from "../_shared/stripe.ts";

const paidEvents = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];

/** Stripe's notifications: no login, the request is signed. */
export function createWebhookHandler(deps: {
  server: Database;
  secret: string | null;
  now?: () => number;
}): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!deps.secret) throw new HttpError(503, "Payment webhook not configured");
    if (req.method !== "POST") throw new HttpError(404, "Not found");
    // the signature covers the body exactly as it arrived
    const body = await req.text();
    let event;
    try {
      event = await readWebhook(body, req.headers.get("stripe-signature"), deps.secret, {
        now: deps.now?.() ?? Date.now(),
      });
    } catch (error) {
      if (error instanceof InvalidSignature) throw new HttpError(400, error.message);
      throw new HttpError(400, "The body must be a JSON object");
    }
    if (paidEvents.includes(event.type) && event.data?.object) {
      await applyPaidSession(deps.server, event.data.object);
    }
    return json({ received: true });
  };
}
