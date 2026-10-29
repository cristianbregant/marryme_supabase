import { assertEquals } from "jsr:@std/assert@1";
import { createApiHandler } from "../api/handler.ts";
import { Database } from "../_shared/database.ts";
import { serve } from "../_shared/http.ts";
import { FakeDatabase, request } from "./fakes.ts";

const WEDDING = "5001ef10-d82d-41d8-bd49-3aca6220fb8d";

Deno.test("api: opens the invitation by its code", async () => {
  const db = new FakeDatabase({ rpc: () => ({ tipoInvito: "pranzo" }) });
  const response = await serve(createApiHandler(db))(request("/functions/v1/api/invito/Gz7Qa%21Km"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { tipoInvito: "pranzo" });
  assertEquals(db.calls[0], { kind: "rpc", target: "open_invitation", args: { code: "Gz7Qa!Km" }, token: undefined });
});

Deno.test("api: message from the app's form", async () => {
  const db = new FakeDatabase();
  const response = await serve(createApiHandler(db))(request("/api/messaggi", {
    method: "POST",
    body: new URLSearchParams({ id_matrimonio: WEDDING, mittente: " Zia Anna ", messaggio: "Auguri!" }),
  }));
  assertEquals(response.status, 200);
  assertEquals(db.calls[0].args, { wedding_id: WEDDING, sender: "Zia Anna", body: "Auguri!" });
});

Deno.test("api: RSVP from the app's form, with its field names", async () => {
  const db = new FakeDatabase();
  const handler = serve(createApiHandler(db));
  await handler(request("/api/rsvp", {
    method: "POST",
    body: new URLSearchParams({
      codice_invito: "abc", id_matrimonio: WEDDING, nome: "Rossi", partecipa: "1", numero_persone: "4", note: "Celiaco",
    }),
  }));
  await handler(request("/api/rsvp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_matrimonio: WEDDING, nome: "Verdi", partecipa: 0, numero_persone: "tanti" }),
  }));
  assertEquals(db.calls[0].args, {
    wedding_id: WEDDING, invitation_code: "abc", name: "Rossi", attending: true, party_size: 4, notes: "Celiaco",
  });
  assertEquals(db.calls[1].args, {
    wedding_id: WEDDING, invitation_code: null, name: "Verdi", attending: false, party_size: 1, notes: "",
  });
});

Deno.test("api: invalid wedding id and unknown routes are 404", async () => {
  const handler = serve(createApiHandler(new FakeDatabase()));
  const bad = await handler(request("/api/messaggi", {
    method: "POST",
    body: new URLSearchParams({ id_matrimonio: "42", mittente: "a", messaggio: "b" }),
  }));
  assertEquals(bad.status, 404);
  assertEquals((await handler(request("/api/nothing"))).status, 404);
  assertEquals(await (await handler(request("/api"))).json(), { status: "ok" });
});

Deno.test("api: the database errors keep their status and message", async () => {
  // the real client against a fake PostgREST
  const db = new Database("http://database", "key", () =>
    Promise.resolve(Response.json({ code: "PT404", message: "Invitation not found: check the link you received" }, {
      status: 404,
    })));
  const response = await serve(createApiHandler(db))(request("/api/invito/missing"));
  assertEquals(response.status, 404);
  assertEquals(await response.json(), { message: "Invitation not found: check the link you received" });
});

Deno.test("api: unexpected failures become a generic 500", async () => {
  const db = new Database("http://database", "key", () => Promise.resolve(new Response("boom", { status: 500 })));
  const original = console.error;
  console.error = () => {};
  try {
    const response = await serve(createApiHandler(db))(request("/api/invito/x"));
    assertEquals(response.status, 500);
    assertEquals(await response.json(), { message: "Internal server error" });
  } finally {
    console.error = original;
  }
});
