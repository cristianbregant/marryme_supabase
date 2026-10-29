import { HttpError } from "./http.ts";

/**
 * Calls the Supabase REST API (PostgREST) of this project. With [token] the
 * request runs as that user (so RLS applies); with the service role key it
 * runs as the server. Errors raised by the database with SQLSTATE "PTnnn"
 * come back as HttpError with status nnn and their message.
 */
export class Database {
  constructor(
    readonly url: string,
    readonly apiKey: string,
    readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** The project's own database, as the server (service role). */
  static asServer(fetchFn: typeof fetch = fetch): Database {
    return new Database(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, fetchFn);
  }

  /** The project's own database, as a guest or as the user of [token]. */
  static asClient(fetchFn: typeof fetch = fetch): Database {
    return new Database(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, fetchFn);
  }

  /** Calls the SQL function [name] with [args]. */
  rpc<T>(name: string, args: Record<string, unknown>, token?: string): Promise<T> {
    return this.request<T>("POST", `/rest/v1/rpc/${name}`, args, token);
  }

  /** GET on a table or view, e.g. `weddings?id=eq.1&select=*`. */
  select<T>(query: string, token?: string): Promise<T[]> {
    return this.request<T[]>("GET", `/rest/v1/${query}`, undefined, token);
  }

  /** PATCH of the rows matching [query] with [values]; returns the rows changed. */
  update<T = Record<string, unknown>>(query: string, values: Record<string, unknown>, token?: string): Promise<T[]> {
    return this.request<T[]>("PATCH", `/rest/v1/${query}`, values, token, "return=representation");
  }

  async request<T>(method: string, path: string, body?: unknown, token?: string, prefer = "return=minimal"): Promise<T> {
    const response = await this.fetchFn(`${this.url}${path}`, {
      method,
      headers: {
        apikey: this.apiKey,
        Authorization: `Bearer ${token ?? this.apiKey}`,
        "Content-Type": "application/json",
        Prefer: prefer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (response.ok) return data as T;
    const code = typeof data?.code === "string" ? data.code : "";
    if (/^PT\d{3}$/.test(code)) throw new HttpError(Number(code.slice(2)), data.message);
    if (response.status === 401 || response.status === 403) throw new HttpError(403, "Not authorized");
    throw new Error(`Database ${response.status}: ${text}`);
  }
}
