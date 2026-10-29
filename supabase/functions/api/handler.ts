import { Database } from "../_shared/database.ts";
import { HttpError, json, readBody } from "../_shared/http.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First of the given fields that is present (the app uses its own names). */
function field(body: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (body[name] != null) return body[name];
  return undefined;
}

const text = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");

function weddingId(body: Record<string, unknown>): string {
  const id = text(field(body, "id_matrimonio", "idMatrimonio", "wedding_id"));
  if (!uuid.test(id)) throw new HttpError(404, "Wedding not found");
  return id;
}

/**
 * The API of the guest app, on the routes it already calls (relative to
 * the function, e.g. https://<project>.supabase.co/functions/v1/api):
 *
 * - GET  /invito/<code>  the invitation, in the app's format
 * - POST /messaggi       a message to the couple (form or JSON)
 * - POST /rsvp           an RSVP response (form or JSON)
 *
 * No login: the database functions only need the invitation code or the
 * wedding id the app got with the invitation.
 */
export function createApiHandler(db: Database): (req: Request) => Promise<Response> {
  return async (req) => {
    // the path after the function name, e.g. /invito/abc
    const path = new URL(req.url).pathname.replace(/^.*?\/api(?=\/|$)/, "") || "/";

    if (req.method === "GET" && path === "/") return json({ status: "ok" });

    const invitation = path.match(/^\/invito\/([^/]+)$/);
    if (req.method === "GET" && invitation) {
      return json(await db.rpc("open_invitation", { code: decodeURIComponent(invitation[1]) }));
    }

    if (req.method === "POST" && path === "/messaggi") {
      const body = await readBody(req);
      await db.rpc("send_guest_message", {
        wedding_id: weddingId(body),
        sender: text(body.mittente),
        body: text(body.messaggio),
      });
      return json({ message: "Message sent" });
    }

    if (req.method === "POST" && path === "/rsvp") {
      const body = await readBody(req);
      const people = Number.parseInt(text(field(body, "numero_persone", "persone")) || "1", 10);
      await db.rpc("send_rsvp", {
        wedding_id: weddingId(body),
        invitation_code: text(field(body, "codice_invito", "codiceInvito")) || null,
        name: text(body.nome),
        attending: [true, 1, "1", "true"].includes(body.partecipa as never),
        party_size: Number.isFinite(people) ? people : 1,
        notes: text(body.note),
      });
      return json({ message: "Response sent" });
    }

    throw new HttpError(404, "Not found");
  };
}
