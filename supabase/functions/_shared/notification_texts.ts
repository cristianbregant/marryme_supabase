/** Languages of the app: each has its own topic and its own translation. */
export const LANGUAGES = ["it", "en", "fr", "de"] as const;
export type Language = typeof LANGUAGES[number];

type Couple = { partner1_name: string | null; partner2_name: string | null };

const texts = {
  it: {
    and: "e",
    dayTitle: "È il grande giorno! 💍",
    dayBody: (n: string) => `Oggi ${n} si sposano: apri l'invito per tutti i dettagli della giornata.`,
    photosTitle: (n: string) => `Nuove foto da ${n} 📸`,
    onePhoto: "È arrivata una nuova foto: guardala in Momenti.",
    photos: (q: number) => `Sono arrivate ${q} nuove foto: guardale in Momenti.`,
    oneAlbum: "C'è un nuovo album da sfogliare in Momenti.",
    albums: (q: number) => `Ci sono ${q} nuovi album da sfogliare in Momenti.`,
    photosAndAlbums: "Ci sono nuove foto e nuovi album da sfogliare in Momenti.",
  },
  en: {
    and: "and",
    dayTitle: "It's the big day! 💍",
    dayBody: (n: string) => `Today ${n} are getting married: open the invitation for all the details of the day.`,
    photosTitle: (n: string) => `New photos from ${n} 📸`,
    onePhoto: "A new photo has arrived: see it in Moments.",
    photos: (q: number) => `${q} new photos have arrived: see them in Moments.`,
    oneAlbum: "There's a new album to browse in Moments.",
    albums: (q: number) => `There are ${q} new albums to browse in Moments.`,
    photosAndAlbums: "There are new photos and albums to browse in Moments.",
  },
  fr: {
    and: "et",
    dayTitle: "C'est le grand jour ! 💍",
    dayBody: (n: string) => `Aujourd'hui, ${n} se marient : ouvre l'invitation pour tous les détails de la journée.`,
    photosTitle: (n: string) => `Nouvelles photos de ${n} 📸`,
    onePhoto: "Une nouvelle photo est arrivée : découvre-la dans Moments.",
    photos: (q: number) => `${q} nouvelles photos sont arrivées : découvre-les dans Moments.`,
    oneAlbum: "Un nouvel album est à feuilleter dans Moments.",
    albums: (q: number) => `${q} nouveaux albums sont à feuilleter dans Moments.`,
    photosAndAlbums: "De nouvelles photos et de nouveaux albums sont à feuilleter dans Moments.",
  },
  de: {
    and: "und",
    dayTitle: "Der große Tag ist da! 💍",
    dayBody: (n: string) => `Heute heiraten ${n}: Öffne die Einladung für alle Details des Tages.`,
    photosTitle: (n: string) => `Neue Fotos von ${n} 📸`,
    onePhoto: "Ein neues Foto ist da: Schau es dir unter Momente an.",
    photos: (q: number) => `${q} neue Fotos sind da: Schau sie dir unter Momente an.`,
    oneAlbum: "Ein neues Album wartet unter Momente auf dich.",
    albums: (q: number) => `${q} neue Alben warten unter Momente auf dich.`,
    photosAndAlbums: "Neue Fotos und Alben warten unter Momente auf dich.",
  },
};

/** "Anna e Luca", "Anna and Luca"… */
const names = (w: Couple, language: Language) =>
  [w.partner1_name, w.partner2_name].filter(Boolean).join(` ${texts[language].and} `);

/** The wedding day notification in [language]. */
export function weddingDayText(w: Couple, language: Language) {
  const t = texts[language];
  return { title: t.dayTitle, body: t.dayBody(names(w, language)) };
}

/** The new photos and albums notification in [language]. */
export function newPhotosText(w: Couple, language: Language, { photos, albums }: { photos: number; albums: number }) {
  const t = texts[language];
  const title = t.photosTitle(names(w, language));
  if (albums > 0 && photos === 0) return { title, body: albums === 1 ? t.oneAlbum : t.albums(albums) };
  if (albums > 0) return { title, body: t.photosAndAlbums };
  return { title, body: photos === 1 ? t.onePhoto : t.photos(photos) };
}
