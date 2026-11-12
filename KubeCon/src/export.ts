/**
 * "Download my sessions": a short-lived link that returns the signed-in user's favorite and
 * interested sessions as JSON, with everything the Sessionize feeds publish for them, fetched
 * live when the link is opened. Nothing is written to D1 (the stored schedule is not refreshed).
 *
 * The link itself is the credential: /export/<token>, where the token is signed with
 * SESSION_SECRET, has typ "export", the user id and a 5-minute expiry. It can't be used as a
 * session or OAuth token (those check typ and fields), and a session token can't be used here.
 */
import { signToken, verifyToken } from "./auth";
import { FEEDS } from "./importer";
import type { Env, FeedKind } from "./types";

export const EXPORT_TTL_SECONDS = 5 * 60;
const FETCH_TIMEOUT_MS = 20_000;

interface ExportToken {
  typ: string;
  uid: string;
  exp: number;
}

export async function createExportLink(env: Env, origin: string, uid: string, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + EXPORT_TTL_SECONDS;
  const token = await signToken({ typ: "export", uid, exp }, env.SESSION_SECRET);
  return { url: `${origin}/export/${token}`, expiresAt: new Date(exp * 1000).toISOString() };
}

async function readExportToken(token: string, env: Env): Promise<ExportToken | null> {
  const t = await verifyToken<ExportToken>(token, env.SESSION_SECRET);
  if (!t || t.typ !== "export" || typeof t.uid !== "string" || !t.uid) return null;
  return t;
}

function jsonResponse(data: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

type Raw = Record<string, any>;

/** GET /export/<token> */
export async function exportDownload(token: string, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const t = await readExportToken(token, env);
  if (!t) return jsonResponse({ error: "This download link is invalid or has expired. Create a new one in the planner." }, 410);

  const { results } = await env.DB.prepare("SELECT session_id, status FROM selections WHERE user_id = ? ORDER BY created_at")
    .bind(t.uid)
    .all<{ session_id: string; status: string }>();
  const wanted = new Map((results ?? []).map((r) => [r.session_id, r.status]));

  let feeds: { kind: FeedKind; data: Raw }[];
  try {
    feeds = await Promise.all(
      FEEDS.map(async ({ kind, code }) => {
        const res = await fetchImpl(`https://sessionize.com/api/v2/${code}/view/All`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`Feed "${kind}" failed: HTTP ${res.status}`);
        const data = (await res.json()) as Raw;
        if (!data || !Array.isArray(data.sessions)) throw new Error(`Feed "${kind}": unexpected JSON shape`);
        return { kind, data };
      }),
    );
  } catch (e) {
    const msg = (e as Error).message;
    return jsonResponse({ error: /^Feed "/.test(msg) ? msg : "Could not reach Sessionize. Try the link again." }, 502);
  }

  const out: Raw[] = [];
  const found = new Set<string>();
  for (const { kind, data } of feeds) {
    const speakers = new Map<string, Raw>((data.speakers ?? []).map((s: Raw) => [String(s.id), s]));
    const rooms = new Map<string, Raw>((data.rooms ?? []).map((r: Raw) => [String(r.id), r]));
    const questions = new Map<string, Raw>((data.questions ?? []).map((q: Raw) => [String(q.id), q]));
    const items = new Map<string, { category: string; item: string }>();
    for (const c of data.categories ?? []) for (const it of c.items ?? []) items.set(String(it.id), { category: String(c.title ?? "").trim(), item: String(it.name ?? "") });

    for (const s of data.sessions as Raw[]) {
      const id = String(s.id);
      const status = wanted.get(id);
      if (!status || found.has(id)) continue; // first feed in priority order wins, as in the importer
      found.add(id);
      out.push({
        status,
        feed: kind,
        session: s,
        speakers: (s.speakers ?? []).map((sid: unknown) => speakers.get(String(sid)) ?? { id: String(sid) }),
        room: s.roomId == null ? null : rooms.get(String(s.roomId)) ?? { id: s.roomId },
        categories: (s.categoryItems ?? []).map((cid: unknown) => items.get(String(cid)) ?? { id: cid }),
        questionAnswers: (s.questionAnswers ?? []).map((a: Raw) => ({
          question: questions.get(String(a.questionId))?.question ?? String(a.questionId),
          answer: a.answerValue,
        })),
      });
    }
  }
  out.sort((a, b) => String(a.session.startsAt ?? "").localeCompare(String(b.session.startsAt ?? "")));

  const generatedAt = new Date().toISOString();
  return jsonResponse(
    {
      event: "KubeCon + CloudNativeCon North America 2026",
      generatedAt,
      source: "Sessionize public API, fetched live when this file was downloaded",
      timeZone: "Session times are local Salt Lake City wall-clock time (America/Denver, MST = UTC-7)",
      counts: {
        favorite: out.filter((x) => x.status === "favorite").length,
        interested: out.filter((x) => x.status === "interested").length,
      },
      sessions: out,
      notFoundInFeeds: [...wanted.keys()].filter((id) => !found.has(id)),
    },
    200,
    { "content-disposition": `attachment; filename="kubecon-na-2026-my-sessions-${generatedAt.slice(0, 10)}.json"` },
  );
}
