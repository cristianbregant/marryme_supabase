/** A Firebase service account, as downloaded from the console. */
export type ServiceAccount = { project_id: string; client_email: string; private_key: string };

export type PushMessage = { topic: string; title: string; body: string; data?: Record<string, string> };

const base64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Push notifications with Firebase Cloud Messaging (HTTP v1 API),
 * authenticated with the service account of the Firebase project.
 */
export class Fcm {
  #token: string | null = null;
  #expires = 0;

  constructor(readonly account: ServiceAccount, readonly fetchFn: typeof fetch = fetch) {
    if (!account?.project_id || !account.client_email || !account.private_key) {
      throw new Error("Invalid Firebase service account: project_id, client_email and private_key are required");
    }
  }

  /** OAuth token for FCM, renewed a few minutes before it expires. */
  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#expires) return this.#token;
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({
      iss: this.account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
    const pem = this.account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)),
    );
    const response = await this.fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${base64url(signature)}`,
      }),
    });
    const data = await response.json();
    if (!response.ok || typeof data.access_token !== "string") {
      throw new Error(`Firebase token not obtained (${response.status}): ${JSON.stringify(data)}`);
    }
    this.#token = data.access_token;
    this.#expires = Date.now() + ((data.expires_in ?? 3600) - 300) * 1000;
    return data.access_token;
  }

  /** Sends a notification to every device subscribed to [topic]. */
  async send({ topic, title, body, data = {} }: PushMessage): Promise<void> {
    const response = await this.fetchFn(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.#accessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            topic,
            notification: { title, body },
            // the app stores them with the notification to know its wedding
            data,
            android: { priority: "high", notification: { sound: "default" } },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`Notification not sent (${response.status}): ${await response.text()}`);
  }
}
