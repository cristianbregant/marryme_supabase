import { Database } from "../_shared/database.ts";
import { HttpError, json } from "../_shared/http.ts";

/**
 * The account of the signed-in user, for the app and the panel:
 *
 * - POST /delete  deletes the account with everything that belongs to it:
 *   the couple's weddings (with invitations, messages and responses), their
 *   photos in Storage and the guest's saved invitations. RSVP responses sent
 *   to other couples stay theirs, without the link to the account.
 *
 * The user is the one of the token: nobody can delete someone else's account.
 */
export function createAccountHandler(server: Database): (req: Request) => Promise<Response> {
  const { url, apiKey, fetchFn } = server;
  const asServer = { apikey: apiKey, Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  async function userOf(token: string): Promise<string> {
    const response = await fetchFn(`${url}/auth/v1/user`, {
      headers: { apikey: apiKey, Authorization: `Bearer ${token}` },
    });
    const user = response.ok ? await response.json() : null;
    if (typeof user?.id !== "string") throw new HttpError(403, "Not authorized");
    return user.id;
  }

  /** Removes the photos in the folder of wedding [id]. */
  async function deletePhotos(id: string): Promise<void> {
    const listed = await fetchFn(`${url}/storage/v1/object/list/photos`, {
      method: "POST",
      headers: asServer,
      body: JSON.stringify({ prefix: `${id}/`, limit: 1000, offset: 0 }),
    });
    if (!listed.ok) throw new Error(`Storage ${listed.status}: ${await listed.text()}`);
    const names = ((await listed.json()) as { name: string }[]).map((file) => `${id}/${file.name}`);
    if (names.length === 0) return;
    const deleted = await fetchFn(`${url}/storage/v1/object/photos`, {
      method: "DELETE",
      headers: asServer,
      body: JSON.stringify({ prefixes: names }),
    });
    if (!deleted.ok) throw new Error(`Storage ${deleted.status}: ${await deleted.text()}`);
  }

  return async (req) => {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(403, "Not authorized");
    const path = new URL(req.url).pathname.replace(/^.*?\/account(?=\/|$)/, "") || "/";
    if (req.method !== "POST" || path !== "/delete") throw new HttpError(404, "Not found");

    const userId = await userOf(token);
    const weddings = await server.select<{ id: string }>(`weddings?owner_id=eq.${userId}&select=id`);
    for (const wedding of weddings) await deletePhotos(wedding.id);
    // the rest goes with the user (foreign keys "on delete cascade")
    const deleted = await fetchFn(`${url}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: asServer });
    if (!deleted.ok) throw new Error(`Auth ${deleted.status}: ${await deleted.text()}`);
    return json({ message: "Account deleted" });
  };
}
