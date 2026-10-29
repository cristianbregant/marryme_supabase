// The guest app's API: open an invitation, send a message, send an RSVP.
import { Database } from "../_shared/database.ts";
import { serve } from "../_shared/http.ts";
import { createApiHandler } from "./handler.ts";

Deno.serve(serve(createApiHandler(Database.asClient())));
