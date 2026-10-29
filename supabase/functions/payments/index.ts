// Full plan payments with Stripe Checkout, called by the panel.
import { Database } from "../_shared/database.ts";
import { serve } from "../_shared/http.ts";
import { Stripe } from "../_shared/stripe.ts";
import { createPaymentsHandler } from "./handler.ts";

const secretKey = Deno.env.get("STRIPE_SECRET_KEY");

Deno.serve(serve(createPaymentsHandler({
  client: Database.asClient(),
  server: Database.asServer(),
  // without the key payments answer 503
  stripe: secretKey ? new Stripe(secretKey) : null,
  panelUrl: (Deno.env.get("PANEL_URL") ?? "http://localhost:8081").replace(/\/+$/, ""),
})));
