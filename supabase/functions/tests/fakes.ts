import { Database } from "../_shared/database.ts";

/** Database stand-in: answers rpc/select/update with the given functions and records the calls. */
export class FakeDatabase extends Database {
  calls: { kind: string; target: string; args?: unknown; token?: string }[] = [];

  constructor(
    readonly answers: {
      rpc?: (name: string, args: Record<string, unknown>) => unknown;
      select?: (query: string, token?: string) => unknown[];
      update?: (query: string, values: Record<string, unknown>) => unknown[];
    } = {},
  ) {
    super("http://database", "key");
  }

  override rpc<T>(name: string, args: Record<string, unknown>, token?: string): Promise<T> {
    this.calls.push({ kind: "rpc", target: name, args, token });
    return Promise.resolve().then(() => this.answers.rpc?.(name, args) as T);
  }

  override select<T>(query: string, token?: string): Promise<T[]> {
    this.calls.push({ kind: "select", target: query, token });
    return Promise.resolve().then(() => (this.answers.select?.(query, token) ?? []) as T[]);
  }

  override update<T>(query: string, values: Record<string, unknown>, token?: string): Promise<T[]> {
    this.calls.push({ kind: "update", target: query, args: values, token });
    return Promise.resolve().then(() => (this.answers.update?.(query, values) ?? [{}]) as T[]);
  }
}

export const request = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);
