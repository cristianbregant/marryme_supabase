import { HttpError } from "./http.ts";

/** Invalid, missing or expired webhook signature. */
export class InvalidSignature extends Error {}

export type CheckoutSession = {
  id: string;
  url?: string;
  client_reference_id?: string | null;
  payment_status?: string;
  amount_total?: number | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
};

/**
 * Stripe Checkout through its REST API: the couple pays on a Stripe page,
 * so card details never reach us.
 */
export class Stripe {
  constructor(
    readonly secretKey: string,
    readonly fetchFn: typeof fetch = fetch,
    readonly baseUrl = "https://api.stripe.com/v1",
  ) {}

  createCheckoutSession(p: {
    weddingId: string;
    userId: string;
    productName: string;
    description: string;
    amount: number;
    currency: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession> {
    return this.#call("POST", "/checkout/sessions", {
      mode: "payment",
      client_reference_id: p.weddingId,
      "metadata[wedding_id]": p.weddingId,
      "metadata[user_id]": p.userId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": p.currency,
      "line_items[0][price_data][unit_amount]": String(p.amount),
      "line_items[0][price_data][product_data][name]": p.productName,
      "line_items[0][price_data][product_data][description]": p.description,
      // Stripe replaces {CHECKOUT_SESSION_ID}
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
    });
  }

  getSession(id: string): Promise<CheckoutSession> {
    return this.#call("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
  }

  async #call(method: string, path: string, fields?: Record<string, string>): Promise<CheckoutSession> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(fields && { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      body: fields ? new URLSearchParams(fields).toString() : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      // Stripe's details stay in the logs
      console.error(`Stripe ${response.status}: ${text}`);
      throw new HttpError(503, "The payment service is not responding. Please try again shortly.");
    }
    return JSON.parse(text);
  }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Comparison that takes the same time whatever the content. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/**
 * Checks the `Stripe-Signature` header of a webhook and returns the event.
 * Throws InvalidSignature if the signature is missing, wrong or too old
 * (against replays).
 */
export async function readWebhook(
  body: string,
  signatureHeader: string | null,
  secret: string,
  { now = Date.now(), toleranceMs = 5 * 60 * 1000 } = {},
): Promise<{ type: string; data?: { object?: CheckoutSession } }> {
  if (!signatureHeader) throw new InvalidSignature("Missing signature");
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim());
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  const seconds = Number.parseInt(timestamp ?? "", 10);
  if (!Number.isFinite(seconds) || signatures.length === 0) throw new InvalidSignature("Invalid signature");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
  if (!signatures.some((s) => sameText(s, expected))) throw new InvalidSignature("Invalid signature");
  if (Math.abs(now - seconds * 1000) > toleranceMs) throw new InvalidSignature("Expired webhook");
  return JSON.parse(body);
}
