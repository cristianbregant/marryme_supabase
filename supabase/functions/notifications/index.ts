// Automatic notifications to guests (wedding day, new photos), started by pg_cron.
import { Database } from "../_shared/database.ts";
import { Fcm } from "../_shared/fcm.ts";
import { serve } from "../_shared/http.ts";
import { createNotificationsHandler } from "./handler.ts";

const account = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
const server = Database.asServer();

Deno.serve(serve(createNotificationsHandler({
  server,
  push: account ? new Fcm(JSON.parse(account)) : null,
  // the secret of the pg_cron job lives in the database's Vault
  isSecret: (secret) => server.rpc<boolean>("is_notifications_secret", { secret }),
})));
