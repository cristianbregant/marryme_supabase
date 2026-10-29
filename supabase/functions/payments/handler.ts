import { Database } from "../_shared/database.ts";
import { HttpError, json, readBody } from "../_shared/http.ts";
import { applyPaidSession, fullPlan } from "../_shared/payments.ts";
import { Stripe } from "../_shared/stripe.ts";

type Wedding = { id: string; owner_id: string; partner1_name: string | null; partner2_name: string | null; plan: string };

/**
 * Payments of the full plan, for the panel (with the couple's login):
 *
 * - POST /checkout { wedding_id }  → { url } of the Stripe payment page
 * - POST /verify   { session_id }  → the wedding, upgraded if the session is paid
 *
 * The wedding is read with the couple's token, so the database rules make
 * sure it is theirs; the plan is changed as the server.
 */
export function createPaymentsHandler(deps: {
  client: Database;
  server: Database;
  stripe: Stripe | null;
  panelUrl: string;
}): (req: Request) => Promise<Response> {
  const { client, server, stripe, panelUrl } = deps;

  const activeStripe = () => {
    if (!stripe) throw new HttpError(503, "Payments are not active yet");
    return stripe;
  };

  /** The wedding [id] if it belongs to the user of [token], otherwise 404. */
  async function ownWedding(id: unknown, token: string): Promise<Wedding> {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Wedding not found");
    const [wedding] = await client.select<Wedding>(`weddings?id=eq.${id}&select=*`, token);
    if (!wedding) throw new HttpError(404, "Wedding not found");
    return wedding;
  }

  return async (req) => {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(403, "Not authorized");
    const path = new URL(req.url).pathname.replace(/^.*?\/payments(?=\/|$)/, "") || "/";
    if (req.method !== "POST") throw new HttpError(404, "Not found");
    const body = await readBody(req);

    if (path === "/checkout") {
      const wedding = await ownWedding(body.wedding_id, token);
      if (wedding.plan === "full") throw new HttpError(409, "This wedding already has the full plan");
      const back = `${panelUrl}/matrimonio/${wedding.id}/configurazione`;
      const names = [wedding.partner1_name, wedding.partner2_name].filter(Boolean).join(" & ");
      const session = await activeStripe().createCheckoutSession({
        weddingId: wedding.id,
        userId: wedding.owner_id,
        productName: "MarryMe – Full plan",
        description: `Digital invitation for the wedding of ${names}`,
        amount: fullPlan.price,
        currency: fullPlan.currency,
        successUrl: `${back}?pagamento=ok&sessione={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${back}?pagamento=annullato`,
      });
      return json({ url: session.url });
    }

    if (path === "/verify") {
      if (typeof body.session_id !== "string" || !body.session_id) throw new HttpError(400, "Missing session_id");
      const session = await activeStripe().getSession(body.session_id);
      // the wedding must belong to whoever asks
      const wedding = await ownWedding(session.client_reference_id, token);
      await applyPaidSession(server, session);
      return json(await ownWedding(wedding.id, token));
    }

    throw new HttpError(404, "Not found");
  };
}
