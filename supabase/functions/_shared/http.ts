/** An error with the HTTP status and the message to send back. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * Runs [handler], answering CORS preflights and turning errors into
 * `{message}` responses: HttpError with its status, anything else as a
 * generic 500 (the details stay in the logs).
 */
export function serve(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    try {
      return await handler(req);
    } catch (error) {
      if (error instanceof HttpError) return json({ message: error.message }, error.status);
      console.error(error);
      return json({ message: "Internal server error" }, 500);
    }
  };
}

/** Body as a plain object, from JSON or from a form (the app sends forms). */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    return Object.fromEntries((await req.formData()).entries());
  }
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // handled below
  }
  throw new HttpError(400, "The body must be a JSON object");
}

/** Required environment variable. */
export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
