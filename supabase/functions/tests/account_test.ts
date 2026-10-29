import { assertEquals } from "jsr:@std/assert@1";
import { Database } from "../_shared/database.ts";
import { serve } from "../_shared/http.ts";
import { createAccountHandler } from "../account/handler.ts";
import { request } from "./fakes.ts";

const WEDDING = "5001ef10-d82d-41d8-bd49-3aca6220fb8d";

/** Supabase stand-in: Anna's token, one wedding with two photos. */
function fakeSupabase() {
  const calls: { method: string; path: string; body?: unknown; auth: string | null }[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: pathname + search, body, auth: headers.get("authorization") });
    if (pathname === "/auth/v1/user") {
      return headers.get("authorization") === "Bearer anna"
        ? Response.json({ id: "u-anna" })
        : Response.json({ msg: "invalid JWT" }, { status: 401 });
    }
    if (pathname === "/rest/v1/weddings") return Response.json([{ id: WEDDING }]);
    if (pathname === "/storage/v1/object/list/photos") return Response.json([{ name: "a.jpg" }, { name: "b.png" }]);
    return Response.json({});
  };
  return { db: new Database("http://supabase", "service", fetchFn as typeof fetch), calls };
}

const post = (path: string, token?: string) =>
  request(`/functions/v1/account${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

Deno.test("account: deletes the photos of the couple's weddings, then the user", async () => {
  const { db, calls } = fakeSupabase();
  const response = await serve(createAccountHandler(db))(post("/delete", "anna"));
  assertEquals(response.status, 200);
  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /auth/v1/user",
    "GET /rest/v1/weddings?owner_id=eq.u-anna&select=id",
    "POST /storage/v1/object/list/photos",
    "DELETE /storage/v1/object/photos",
    "DELETE /auth/v1/admin/users/u-anna",
  ]);
  assertEquals(calls[3].body, { prefixes: [`${WEDDING}/a.jpg`, `${WEDDING}/b.png`] });
  // everything but reading the user runs as the server
  assertEquals(calls.slice(1).every((c) => c.auth === "Bearer service"), true);
});

Deno.test("account: only with a valid login, only POST /delete", async () => {
  const { db, calls } = fakeSupabase();
  const handler = serve(createAccountHandler(db));
  assertEquals((await handler(post("/delete"))).status, 403);
  assertEquals((await handler(post("/delete", "forged"))).status, 403);
  assertEquals((await handler(post("/other", "anna"))).status, 404);
  assertEquals(calls.some((c) => c.method === "DELETE"), false);
});
