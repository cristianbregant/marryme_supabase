// The signed-in user's account (deletion), called by the app and the panel.
import { Database } from "../_shared/database.ts";
import { serve } from "../_shared/http.ts";
import { createAccountHandler } from "./handler.ts";

Deno.serve(serve(createAccountHandler(Database.asServer())));
