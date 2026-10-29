import { Database } from "../_shared/database.ts";
import type { PushMessage } from "../_shared/fcm.ts";
import { HttpError, json } from "../_shared/http.ts";
import { type Language, LANGUAGES, newPhotosText, weddingDayText } from "../_shared/notification_texts.ts";

type Notifications = {
  weddingDay?: string;
  pendingPhotos?: { photos: number; albums: number; since: number };
  lastPhotos?: number;
  // topics already reached by a notification, when a send stopped halfway
  sent?: Record<string, string[]>;
};

type Wedding = {
  id: string;
  partner1_name: string | null;
  partner2_name: string | null;
  plan: string;
  sections: Record<string, { enabled?: boolean } | undefined>;
  notifications: Notifications;
  updated_at: string;
};

/** Hour from which the wedding day notification goes out. */
const WEDDING_DAY_HOUR = 9;
/** Wait after the last photo added, so an upload in several steps sends one notification. */
const PHOTOS_DELAY_MS = 10 * 60 * 1000;
/** Wedding days follow the couples' time zone. */
const TIME_ZONE = "Europe/Rome";

/**
 * Firebase topic of a wedding in a language, the same the app subscribes
 * to (e.g. "matrimonio-<id>-it"): topics only allow letters, digits and
 * -_.~%.
 */
export const topicFor = (weddingId: string, language: Language) =>
  `matrimonio-${weddingId.replace(/[^a-zA-Z0-9\-_.~%]/g, "_")}-${language}`;

/** Date ("2027-06-12") and hour of [instant] in the couples' time zone. */
export function localTime(instant: Date): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const galleryVisible = (w: Wedding) => w.sections?.gallery?.enabled === true && w.plan === "full";

const fields = "id,partner1_name,partner2_name,plan,sections,notifications,updated_at";

/**
 * The automatic notifications to guests, sent to the wedding's topics in
 * every language of the app:
 * - on the wedding day, from 9 in the morning;
 * - when the couple adds photos or albums to the gallery, 10 minutes after
 *   the last addition.
 *
 * Called every few minutes by pg_cron, with the secret it keeps in the
 * Vault (see the schedule migration). Each
 * notification goes out once, even after a failure halfway: the progress
 * is stored on the wedding.
 */
export function createNotificationsHandler(deps: {
  server: Database;
  push: { send(message: PushMessage): Promise<void> } | null;
  /** True if the request carries the job's secret. */
  isSecret: (secret: string) => Promise<boolean>;
  now?: () => Date;
}): (req: Request) => Promise<Response> {
  const { server, push, isSecret } = deps;
  const now = deps.now ?? (() => new Date());

  /** Changes `notifications` of the latest version of wedding [id] (retries on concurrent changes). */
  async function mark(id: string, change: (n: Notifications) => Notifications): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [w] = await server.select<Wedding>(`weddings?id=eq.${id}&select=${fields}`);
      if (!w) return;
      const changed = await server.update(
        `weddings?id=eq.${id}&updated_at=eq.${encodeURIComponent(w.updated_at)}`,
        { notifications: change(w.notifications ?? {}) },
      );
      if (changed.length > 0) return;
    }
    throw new Error(`Wedding ${id} keeps changing: notifications not saved`);
  }

  /** Sends notification [key] to every language topic, skipping those already reached. */
  async function announce(
    w: Wedding,
    key: string,
    kind: string,
    text: (language: Language) => { title: string; body: string },
  ): Promise<void> {
    const sent = new Set(w.notifications?.sent?.[key] ?? []);
    try {
      for (const language of LANGUAGES) {
        const topic = topicFor(w.id, language);
        if (sent.has(topic)) continue;
        await push!.send({ topic, ...text(language), data: { idMatrimonio: w.id, tipo: kind } });
        sent.add(topic);
      }
    } catch (error) {
      if (sent.size > 0) await mark(w.id, (n) => ({ ...n, sent: { ...n.sent, [key]: [...sent] } }));
      throw error;
    }
  }

  const withoutSent = (n: Notifications, key: string): Notifications => {
    const { [key]: _, ...others } = n.sent ?? {};
    const { sent: __, ...rest } = n;
    return Object.keys(others).length > 0 ? { ...rest, sent: others } : rest;
  };

  /** Runs [work] for one wedding: a failure is logged and retried next time, without stopping the others. */
  async function each(w: Wedding, errors: string[], work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      const message = `Notification for wedding ${w.id} not sent: ${(error as Error).message}`;
      console.error(message);
      errors.push(message);
    }
  }

  async function weddingDay(errors: string[]): Promise<number> {
    const { date, hour } = localTime(now());
    if (hour < WEDDING_DAY_HOUR) return 0;
    let sent = 0;
    for (const w of await server.select<Wedding>(`weddings?wedding_date=eq.${date}&select=${fields}`)) {
      if (w.notifications?.weddingDay === date) continue;
      const key = `day-${date}`;
      await each(w, errors, async () => {
        await announce(w, key, "giornoMatrimonio", (language) => weddingDayText(w, language));
        await mark(w.id, (n) => ({ ...withoutSent(n, key), weddingDay: date }));
        sent++;
      });
    }
    return sent;
  }

  async function newPhotos(errors: string[]): Promise<number> {
    const limit = now().getTime() - PHOTOS_DELAY_MS;
    let sent = 0;
    for (const w of await server.select<Wedding>(`weddings?notifications->pendingPhotos=not.is.null&select=${fields}`)) {
      const pending = w.notifications.pendingPhotos!;
      if (pending.since > limit) continue;
      const key = `photos-${pending.since}`;
      await each(w, errors, async () => {
        // if the gallery was hidden in the meantime there is nothing to announce
        if (galleryVisible(w)) {
          await announce(w, key, "momenti", (language) => newPhotosText(w, language, pending));
          sent++;
        }
        await mark(w.id, (n) => {
          const { pendingPhotos: _, ...rest } = withoutSent(n, key);
          return { ...rest, lastPhotos: now().getTime() };
        });
      });
    }
    return sent;
  }

  return async (req) => {
    const secret = req.headers.get("x-cron-secret");
    if (!secret || !(await isSecret(secret))) throw new HttpError(403, "Not authorized");
    if (!push) return json({ message: "Notifications off: FIREBASE_SERVICE_ACCOUNT is missing" }, 503);
    const errors: string[] = [];
    const result = { weddingDay: await weddingDay(errors), newPhotos: await newPhotos(errors), errors };
    return json(result, errors.length > 0 ? 207 : 200);
  };
}
