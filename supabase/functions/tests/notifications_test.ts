import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { Fcm, type PushMessage } from "../_shared/fcm.ts";
import { serve } from "../_shared/http.ts";
import { createNotificationsHandler, localTime, topicFor } from "../notifications/handler.ts";
import { FakeDatabase, request } from "./fakes.ts";

const W1 = "5001ef10-d82d-41d8-bd49-3aca6220fb8d";
const SECRET = "cron-secret";

type Row = Record<string, unknown> & { id: string; notifications: Record<string, unknown>; updated_at: string };

/** Weddings in memory, with the PostgREST filters the function uses. */
function weddings(rows: Row[]) {
  let version = 0;
  return new FakeDatabase({
    select: (query) => {
      const date = query.match(/wedding_date=eq\.([\d-]+)/)?.[1];
      const id = query.match(/id=eq\.([0-9a-f-]+)/)?.[1];
      return structuredClone(rows.filter((r) =>
        (date ? r.wedding_date === date : true) &&
        (id ? r.id === id : true) &&
        (query.includes("pendingPhotos=not.is.null") ? r.notifications.pendingPhotos != null : true)
      ));
    },
    update: (query, values) => {
      const id = query.match(/id=eq\.([0-9a-f-]+)/)![1];
      const updatedAt = decodeURIComponent(query.match(/updated_at=eq\.([^&]+)/)![1]);
      const row = rows.find((r) => r.id === id && r.updated_at === updatedAt);
      if (!row) return [];
      Object.assign(row, structuredClone(values), { updated_at: `v${++version}` });
      return [row];
    },
  });
}

/** Firebase stand-in: records the messages; [down] makes those topics fail. */
function fakePush() {
  const sent: PushMessage[] = [];
  const down = new Set<string>();
  return {
    sent,
    down,
    send: (m: PushMessage) => {
      if (down.has(m.topic)) return Promise.reject(new Error(`FCM down for ${m.topic}`));
      sent.push(m);
      return Promise.resolve();
    },
  };
}

const row = (extra: Partial<Row> = {}): Row => ({
  id: W1,
  partner1_name: "Anna",
  partner2_name: "Luca",
  plan: "full",
  wedding_date: "2027-06-12",
  sections: { gallery: { enabled: true } },
  notifications: {},
  updated_at: "v0",
  ...extra,
});

// 2027-06-12 at 10:00 in Rome (UTC+2 in summer)
const at = (iso: string) => () => new Date(iso);
const call = (handler: (r: Request) => Promise<Response>, secret = SECRET) =>
  handler(request("/notifications", { method: "POST", headers: { "x-cron-secret": secret } }));

const quietly = async <T>(work: () => Promise<T>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = original;
  }
};

Deno.test("notifications: the topic and the local time of the couples", () => {
  assertEquals(topicFor(W1, "it"), `matrimonio-${W1}-it`);
  assertEquals(localTime(new Date("2027-06-12T06:59:00Z")), { date: "2027-06-12", hour: 8 });
  assertEquals(localTime(new Date("2027-12-31T23:30:00Z")), { date: "2028-01-01", hour: 0 });
});

Deno.test("notifications: only with the cron secret", async () => {
  const handler = serve(createNotificationsHandler({ server: weddings([]), push: fakePush(), isSecret: (s: string) => Promise.resolve(s === SECRET) }));
  assertEquals((await call(handler, "wrong")).status, 403);
  const missing = await handler(request("/notifications", { method: "POST" }));
  assertEquals(missing.status, 403);
});

Deno.test("notifications: wedding day, once, in every language, from 9 local time", async () => {
  const rows = [row()];
  const push = fakePush();
  let now = at("2027-06-12T06:30:00Z"); // 8:30 in Rome
  const handler = serve(createNotificationsHandler({ server: weddings(rows), push, isSecret: (s: string) => Promise.resolve(s === SECRET), now: () => now() }));

  await call(handler);
  assertEquals(push.sent.length, 0, "too early");

  now = at("2027-06-12T08:00:00Z"); // 10:00 in Rome
  assertEquals((await (await call(handler)).json()).weddingDay, 1);
  await call(handler);
  assertEquals(push.sent.map((m) => m.topic), ["it", "en", "fr", "de"].map((l) => `matrimonio-${W1}-${l}`));
  assertMatch(push.sent[0].body, /Oggi Anna e Luca si sposano/);
  assertMatch(push.sent[1].body, /Today Anna and Luca are getting married/);
  assertMatch(push.sent[3].body, /Heute heiraten Anna und Luca/);
  assertEquals(push.sent[0].data, { idMatrimonio: W1, tipo: "giornoMatrimonio" });
  assertEquals(rows[0].notifications, { weddingDay: "2027-06-12" });
});

Deno.test("notifications: Firebase down halfway, the retry reaches only the missing languages", async () => {
  const rows = [row()];
  const push = fakePush();
  push.down.add(`matrimonio-${W1}-fr`);
  const handler = serve(createNotificationsHandler({ server: weddings(rows), push, isSecret: (s: string) => Promise.resolve(s === SECRET), now: at("2027-06-12T08:00:00Z") }));

  const first = await quietly(() => call(handler));
  assertEquals(first.status, 207);
  assertEquals(push.sent.length, 2);
  assertEquals(rows[0].notifications.weddingDay, undefined);

  push.down.clear();
  await call(handler);
  assertEquals(push.sent.map((m) => m.topic.slice(-2)), ["it", "en", "fr", "de"]);
  assertEquals(rows[0].notifications, { weddingDay: "2027-06-12" }, "progress cleaned up");
});

Deno.test("notifications: new photos, 10 minutes after the last addition", async () => {
  const since = Date.parse("2027-07-01T16:00:00Z");
  const rows = [row({ wedding_date: "2027-06-12", notifications: { pendingPhotos: { photos: 3, albums: 0, since } } })];
  const push = fakePush();
  let now = new Date(since + 5 * 60 * 1000);
  const handler = serve(createNotificationsHandler({ server: weddings(rows), push, isSecret: (s: string) => Promise.resolve(s === SECRET), now: () => now }));

  await call(handler);
  assertEquals(push.sent.length, 0, "still uploading");

  now = new Date(since + 11 * 60 * 1000);
  await call(handler);
  await call(handler);
  assertEquals(push.sent.length, 4);
  assertMatch(push.sent[0].body, /Sono arrivate 3 nuove foto/);
  assertMatch(push.sent[1].title, /New photos from Anna and Luca/);
  assertEquals(push.sent[0].data?.tipo, "momenti");
  assertEquals(rows[0].notifications.pendingPhotos, undefined);
});

Deno.test("notifications: gallery hidden or free plan in the meantime, nothing is sent", async () => {
  const pending = { pendingPhotos: { photos: 1, albums: 0, since: 0 } };
  const rows = [
    row({ sections: { gallery: { enabled: false } }, notifications: structuredClone(pending) }),
    row({ id: "6001ef10-d82d-41d8-bd49-3aca6220fb8d", plan: "free", notifications: structuredClone(pending) }),
  ];
  const push = fakePush();
  await call(serve(createNotificationsHandler({ server: weddings(rows), push, isSecret: (s: string) => Promise.resolve(s === SECRET), now: at("2027-07-01T16:00:00Z") })));
  assertEquals(push.sent.length, 0);
  assert(rows.every((r) => r.notifications.pendingPhotos === undefined));
});

Deno.test("fcm: signs in with the service account and sends to the topic", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;
  const requests: { url: string; init: RequestInit }[] = [];

  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).includes("oauth2")) {
      const jwt = new URLSearchParams(String(init!.body)).get("assertion")!;
      const [header, claims, signature] = jwt.split(".");
      const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, bytes(signature),
        new TextEncoder().encode(`${header}.${claims}`));
      assert(valid, "the JWT is signed with the service account key");
      assertEquals(JSON.parse(atob(claims.replace(/-/g, "+").replace(/_/g, "/"))).iss, "push@test.iam.gserviceaccount.com");
      return Response.json({ access_token: "tok-1", expires_in: 3600 });
    }
    return Response.json({ name: "projects/test/messages/1" });
  };

  const fcm = new Fcm({ project_id: "test", client_email: "push@test.iam.gserviceaccount.com", private_key: pem }, fetchFn as typeof fetch);
  await fcm.send({ topic: `matrimonio-${W1}-it`, title: "Ciao", body: "Prova", data: { idMatrimonio: W1 } });
  await fcm.send({ topic: `matrimonio-${W1}-en`, title: "Hi", body: "Test" });

  assertEquals(requests.filter((r) => r.url.includes("oauth2")).length, 1, "the token is reused");
  const sent = requests.at(-2)!;
  assertEquals(sent.url, "https://fcm.googleapis.com/v1/projects/test/messages:send");
  assertEquals((sent.init.headers as Record<string, string>).Authorization, "Bearer tok-1");
  assertEquals(JSON.parse(String(sent.init.body)).message.notification, { title: "Ciao", body: "Prova" });
});
