// Stripe webhook: confirms full plan payments.
import { Database } from "../_shared/database.ts";
import { serve } from "../_shared/http.ts";
import { createWebhookHandler } from "./handler.ts";

Deno.serve(serve(createWebhookHandler({
  server: Database.asServer(),
  secret: Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? null,
})));
