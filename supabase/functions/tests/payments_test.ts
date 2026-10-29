import { assert, assertEquals } from "jsr:@std/assert@1";
import { serve } from "../_shared/http.ts";
import { readWebhook, Stripe } from "../_shared/stripe.ts";
import { createPaymentsHandler } from "../payments/handler.ts";
import { createWebhookHandler } from "../stripe-webhook/handler.ts";
import { FakeDatabase, request } from "./fakes.ts";

const WEDDING = "5001ef10-d82d-41d8-bd49-3aca6220fb8d";
const SECRET = "whsec_test";

/** Stripe stand-in: remembers sessions and answers like the real API. */
function fakeStripe() {
  const sessions: Record<string, Record<string, unknown>> = {};
  const requests: { method: string; path: string; fields: Record<string, string> }[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const fields = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    requests.push({ method: init?.method ?? "GET", path, fields });
    if (path === "/v1/checkout/sessions") {
      const id = `cs_${Object.keys(sessions).length + 1}`;
      sessions[id] = {
        id,
        url: `https://checkout.stripe.com/c/${id}`,
        client_reference_id: fields.client_reference_id,
        payment_status: "unpaid",
        amount_total: Number(fields["line_items[0][price_data][unit_amount]"]),
        currency: fields["line_items[0][price_data][currency]"],
      };
      return Response.json(sessions[id]);
    }
    const session = sessions[path.split("/").at(-1)!];
    return session ? Response.json(session) : Response.json({ error: {} }, { status: 404 });
  };
  return { stripe: new Stripe("sk_test", fetchFn as typeof fetch), sessions, requests };
}

/** Couples' database: the wedding is visible only with Anna's token (as RLS does). */
const couples = (plan = "free") =>
  new FakeDatabase({
    select: (_query, token) =>
      token === "anna" ? [{ id: WEDDING, owner_id: "u1", partner1_name: "Anna", partner2_name: "Luca", plan }] : [],
  });

const post = (path: string, body: unknown, token?: string) =>
  request(`/functions/v1/payments${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

Deno.test("payments: checkout of 49 € tied to the couple's wedding", async () => {
  const { stripe, requests } = fakeStripe();
  const handler = serve(createPaymentsHandler({ client: couples(), server: new FakeDatabase(), stripe, panelUrl: "https://app" }));
  const response = await handler(post("/checkout", { wedding_id: WEDDING }, "anna"));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).url, "https://checkout.stripe.com/c/cs_1");
  const { fields } = requests[0];
  assertEquals(fields["line_items[0][price_data][unit_amount]"], "4900");
  assertEquals(fields["line_items[0][price_data][currency]"], "eur");
  assertEquals(fields.client_reference_id, WEDDING);
  assertEquals(fields.success_url, `https://app/matrimonio/${WEDDING}/configurazione?pagamento=ok&sessione={CHECKOUT_SESSION_ID}`);
});

Deno.test("payments: other people's weddings, full plan, no login, no Stripe", async () => {
  const { stripe } = fakeStripe();
  const handler = (client = couples(), s: Stripe | null = stripe) =>
    serve(createPaymentsHandler({ client, server: new FakeDatabase(), stripe: s, panelUrl: "https://app" }));
  assertEquals((await handler()(post("/checkout", { wedding_id: WEDDING }, "bruno"))).status, 404);
  assertEquals((await handler(couples("full"))(post("/checkout", { wedding_id: WEDDING }, "anna"))).status, 409);
  assertEquals((await handler()(post("/checkout", { wedding_id: WEDDING }))).status, 403);
  const off = await handler(couples(), null)(post("/checkout", { wedding_id: WEDDING }, "anna"));
  assertEquals(off.status, 503);
  assertEquals((await off.json()).message, "Payments are not active yet");
});

Deno.test("payments: verify upgrades the plan only once paid", async () => {
  const { stripe, sessions } = fakeStripe();
  const server = new FakeDatabase();
  const handler = serve(createPaymentsHandler({ client: couples(), server, stripe, panelUrl: "https://app" }));
  await handler(post("/checkout", { wedding_id: WEDDING }, "anna"));

  await handler(post("/verify", { session_id: "cs_1" }, "anna"));
  assertEquals(server.calls.length, 0, "not paid yet");

  sessions.cs_1.payment_status = "paid";
  const response = await handler(post("/verify", { session_id: "cs_1" }, "anna"));
  assertEquals(response.status, 200);
  assertEquals(server.calls[0].target, `weddings?id=eq.${WEDDING}&plan=eq.free`);
  assertEquals((server.calls[0].args as Record<string, unknown>).plan, "full");

  // someone else's session cannot be used
  assertEquals((await handler(post("/verify", { session_id: "cs_1" }, "bruno"))).status, 404);
});

async function sign(body: string, { secret = SECRET, at = Date.now() } = {}) {
  const t = Math.floor(at / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const event = (status = "paid", amount = 4900) =>
  JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id: "cs_web", client_reference_id: WEDDING, payment_status: status, amount_total: amount, currency: "eur" } },
  });

const webhook = async (server: FakeDatabase, body: string, signature: string | null) =>
  serve(createWebhookHandler({ server, secret: SECRET }))(request("/stripe-webhook", {
    method: "POST",
    headers: signature ? { "Stripe-Signature": signature } : {},
    body,
  }));

Deno.test("webhook: signed payment upgrades the plan", async () => {
  const server = new FakeDatabase();
  const body = event();
  const response = await webhook(server, body, await sign(body));
  assertEquals(response.status, 200);
  assertEquals((server.calls[0].args as Record<string, unknown>).plan, "full");
});

Deno.test("webhook: wrong, missing or old signature is 400 and changes nothing", async () => {
  const server = new FakeDatabase();
  const body = event();
  for (const signature of [
    await sign(body, { secret: "whsec_other" }),
    null,
    await sign(body, { at: Date.now() - 60 * 60 * 1000 }),
    await sign('{"other":1}'),
  ]) {
    assertEquals((await webhook(server, body, signature)).status, 400, String(signature));
  }
  assertEquals(server.calls.length, 0);
});

Deno.test("webhook: unpaid or wrong amount is ignored", async () => {
  const server = new FakeDatabase();
  for (const body of [event("unpaid"), event("paid", 100)]) {
    assertEquals((await webhook(server, body, await sign(body))).status, 200);
  }
  assertEquals(server.calls.length, 0);
});

Deno.test("webhook: the signed body is checked byte by byte", async () => {
  const body = JSON.stringify(JSON.parse(event()), null, 2);
  const parsed = await readWebhook(body, await sign(body), SECRET);
  assert(parsed.type === "checkout.session.completed");
});
