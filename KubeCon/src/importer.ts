import type { FeedKind, Session, Speaker } from "./types";

/** Feeds in merge priority order (R-2.6). */
export const FEEDS: { kind: FeedKind; code: string }[] = [
  { kind: "main", code: "svi82w6c" },
  { kind: "colocated", code: "ayajbd6b" },
  { kind: "maintainer", code: "qtujim6y" },
  { kind: "sponsor", code: "etvmcsmr" },
];

export const COLOCATED_TRACK = "CNCF-hosted Co-located Events";
const COLOCATED_SPECIAL = new Set(["Breaks", "Experiences", "Registration"]);
const FETCH_TIMEOUT_MS = 20_000;
/** Sessionize local wall-clock time, e.g. 2026-11-09T09:30:00 (no offset). */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** Strip leading characters that are neither letters nor digits ("☕ Breaks" -> "Breaks"). */
export function stripLead(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "");
}

function isArr(x: unknown): x is any[] {
  return Array.isArray(x);
}

/** Parse one Sessionize `view/All` response into sessions (R-2.2 to R-2.5). */
export function parseFeed(kind: FeedKind, data: unknown): Session[] {
  const d = data as any;
  if (!d || typeof d !== "object" || !isArr(d.sessions) || !isArr(d.speakers) ||
      !isArr(d.questions) || !isArr(d.categories) || !isArr(d.rooms)) {
    throw new Error(`Feed "${kind}": unexpected JSON shape`);
  }

  const rooms = new Map<string, string>();
  for (const r of d.rooms) rooms.set(String(r.id), String(r.name ?? ""));

  const qByTitle = new Map<string, string>();
  for (const q of d.questions) qByTitle.set(String(q.question ?? "").trim(), String(q.id));
  const companyQ = qByTitle.get("Company");
  const titleQ = qByTitle.get("Speaker Title");

  const speakers = new Map<string, Speaker>();
  for (const sp of d.speakers) {
    const answers = new Map<string, string>();
    for (const a of sp.questionAnswers ?? []) {
      if (a?.answerValue != null && String(a.answerValue).trim() !== "") {
        answers.set(String(a.questionId), String(a.answerValue).trim());
      }
    }
    const company = (companyQ && answers.get(companyQ)) || "";
    const jobTitle = (titleQ && answers.get(titleQ)) || "";
    const tagLine = String(sp.tagLine ?? "").trim();
    speakers.set(String(sp.id), {
      name: String(sp.fullName ?? `${sp.firstName ?? ""} ${sp.lastName ?? ""}`).trim(),
      company,
      title: company ? jobTitle : tagLine || jobTitle,
    });
  }

  const items = new Map<string, { category: string; name: string }>();
  for (const c of d.categories) {
    const category = String(c.title ?? "").trim();
    for (const it of c.items ?? []) items.set(String(it.id), { category, name: String(it.name ?? "") });
  }

  const out: Session[] = [];
  for (const s of d.sessions) {
    // Skip sessions without valid local times. The format is checked because these strings are
    // also used to derive the day and are shown in the UI.
    if (!s || !LOCAL_TIME.test(String(s.startsAt ?? "")) || !LOCAL_TIME.test(String(s.endsAt ?? ""))) continue;
    const cats = (s.categoryItems ?? []).map((id: unknown) => items.get(String(id))).filter(Boolean) as {
      category: string;
      name: string;
    }[];
    const inCat = (title: string) => cats.filter((c) => c.category === title).map((c) => c.name);

    let track: string;
    let format: string | null = null;
    let events: string[] = [];
    if (kind === "colocated") {
      const all = inCat("All Sessions").map(stripLead);
      const special = all.find((n) => COLOCATED_SPECIAL.has(n));
      track = special ?? COLOCATED_TRACK;
      events = all.filter((n) => !COLOCATED_SPECIAL.has(n));
      const f = inCat("Session format")[0];
      format = f != null ? stripLead(f) : null;
    } else if (kind === "maintainer") {
      track = "Maintainer Summit";
      events = ["CNCF Maintainer Summit"];
      format = inCat("Session Category")[0] ?? null;
    } else {
      track = inCat("All Sessions")[0] ?? "Other";
    }

    const sp = (s.speakers ?? [])
      .map((id: unknown) => speakers.get(String(id)))
      .filter(Boolean) as Speaker[];
    const startsAt = String(s.startsAt);
    out.push({
      id: String(s.id),
      source: kind,
      title: String(s.title ?? "").trim(),
      description: s.description == null ? "" : String(s.description),
      day: startsAt.slice(0, 10),
      startsAt,
      endsAt: String(s.endsAt),
      room: s.roomId == null ? "" : rooms.get(String(s.roomId)) ?? "",
      track,
      format,
      events,
      speakers: sp,
      speakerText: sp.map((x) => (x.company ? `${x.name} (${x.company})` : x.name)).join(", "),
    });
  }
  return out;
}

/** Merge parsed feeds (R-2.6). `feeds` may be in any order; priority is fixed. */
export function mergeFeeds(feeds: Partial<Record<FeedKind, Session[]>>): Session[] {
  const order: FeedKind[] = ["main", "colocated", "maintainer", "sponsor"];
  // 1. Repeated IDs: first feed in priority order wins.
  const seen = new Set<string>();
  let merged: Session[] = [];
  for (const kind of order) {
    for (const s of feeds[kind] ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(s);
    }
  }
  // 2. Umbrella placeholders.
  if ((feeds.colocated ?? []).length > 0) {
    merged = merged.filter((s) => !(s.source !== "colocated" && s.track === COLOCATED_TRACK));
  }
  // 3. Registration duplicates.
  if ((feeds.main ?? []).some((s) => s.track === "Registration")) {
    merged = merged.filter((s) => !(s.source === "colocated" && s.track === "Registration"));
  }
  // 4. Order.
  const key = (s: Session) => s.id.padStart(12, "0");
  merged.sort((a, b) =>
    a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
  return merged;
}

/** Fetch and parse all feeds in parallel. Throws naming the first failing feed (R-2.8). */
export async function fetchAllFeeds(fetchImpl: typeof fetch = fetch): Promise<Session[]> {
  const results = await Promise.all(
    FEEDS.map(async ({ kind, code }) => {
      let data: unknown;
      try {
        const res = await fetchImpl(`https://sessionize.com/api/v2/${code}/view/All`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch (e) {
        throw new Error(`Feed "${kind}" failed: ${(e as Error).message}`);
      }
      return [kind, parseFeed(kind, data)] as const;
    }),
  );
  return mergeFeeds(Object.fromEntries(results));
}

export interface ImportResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

const COLS = [
  "id", "source", "title", "description", "day", "starts_at", "ends_at",
  "room", "track", "format", "events", "speakers", "speaker_text",
] as const;

export const UPSERT_SQL =
  `INSERT INTO sessions (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")}) ` +
  `ON CONFLICT(id) DO UPDATE SET ${COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`;
export const DELETE_SQL = "DELETE FROM sessions WHERE id = ?";
export const SELECT_ALL_SQL = `SELECT ${COLS.join(", ")} FROM sessions`;
export const META_SQL = "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v";

function toRow(s: Session): (string | null)[] {
  return [
    s.id, s.source, s.title, s.description, s.day, s.startsAt, s.endsAt, s.room, s.track,
    s.format, JSON.stringify(s.events), JSON.stringify(s.speakers), s.speakerText,
  ];
}

/**
 * Upsert the merged sessions by ID, delete the ones that are gone, and record meta (R-2.9).
 * Never touches `selections` (R-2.10). Refuses an empty result.
 */
export async function storeSessions(db: D1Database, sessions: Session[], now = new Date()): Promise<ImportResult> {
  if (sessions.length === 0) throw new Error("Import produced 0 sessions; keeping the stored schedule");

  const existing = new Map<string, string>();
  const { results } = await db.prepare(SELECT_ALL_SQL).all<Record<string, string | null>>();
  for (const r of results ?? []) existing.set(String(r.id), JSON.stringify(COLS.map((c) => r[c] ?? null)));

  const stmts: D1PreparedStatement[] = [];
  let added = 0;
  let updated = 0;
  const incoming = new Set<string>();
  for (const s of sessions) {
    incoming.add(s.id);
    const row = toRow(s);
    const prev = existing.get(s.id);
    if (prev === undefined) added++;
    else if (prev !== JSON.stringify(row)) updated++;
    else continue;
    stmts.push(db.prepare(UPSERT_SQL).bind(...row));
  }
  let removed = 0;
  for (const id of existing.keys()) {
    if (!incoming.has(id)) {
      removed++;
      stmts.push(db.prepare(DELETE_SQL).bind(id));
    }
  }
  const result: ImportResult = { added, updated, removed, total: sessions.length };
  stmts.push(db.prepare(META_SQL).bind("last_import_at", now.toISOString()));
  stmts.push(db.prepare(META_SQL).bind("last_import_result", JSON.stringify(result)));

  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return result;
}

export async function runImport(db: D1Database, fetchImpl: typeof fetch = fetch): Promise<ImportResult> {
  const sessions = await fetchAllFeeds(fetchImpl);
  return storeSessions(db, sessions);
}
