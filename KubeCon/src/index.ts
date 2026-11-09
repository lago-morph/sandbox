import { callback, currentUser, login, logout } from "./auth";
import { runImport } from "./importer";
import type { Env } from "./types";

export const SELECTION_STATUSES = new Set(["favorite", "interested"]);
export const UPSERT_SELECTION_SQL =
  "INSERT INTO selections (user_id, session_id, status, created_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(user_id, session_id) DO UPDATE SET status = excluded.status";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function lastImportAt(env: Env): Promise<string | null> {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_import_at'").first<{ v: string }>();
  return r?.v ?? null;
}

async function listSessions(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT id, source, title, day, starts_at, ends_at, room, track, format, events, speaker_text FROM sessions ORDER BY starts_at, id",
  ).all<Record<string, string | null>>();
  return (results ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    day: r.day,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    room: r.room,
    track: r.track,
    format: r.format,
    events: JSON.parse(r.events ?? "[]"),
    speakerText: r.speaker_text,
  }));
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== url.origin) {
    return json({ error: "forbidden" }, 403);
  }

  const path = url.pathname;
  if (path === "/api/me" && req.method === "GET") return json({ userId: user.uid, email: user.email });

  if (path === "/api/sessions" && req.method === "GET") {
    let sessions = await listSessions(env);
    if (sessions.length === 0) {
      try {
        await runImport(env.DB);
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
      sessions = await listSessions(env);
    }
    return json({ lastImportAt: await lastImportAt(env), sessions });
  }

  const one = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (one && req.method === "GET") {
    const r = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(decodeURIComponent(one[1])).first<Record<string, string | null>>();
    if (!r) return json({ error: "not found" }, 404);
    return json({
      id: r.id,
      source: r.source,
      title: r.title,
      description: r.description,
      day: r.day,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      room: r.room,
      track: r.track,
      format: r.format,
      events: JSON.parse(r.events ?? "[]"),
      speakers: JSON.parse(r.speakers ?? "[]"),
      speakerText: r.speaker_text,
    });
  }

  if (path === "/api/import" && req.method === "POST") {
    try {
      const result = await runImport(env.DB);
      return json({ ...result, lastImportAt: await lastImportAt(env) });
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  if (path === "/api/selections" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT session_id, status FROM selections WHERE user_id = ? ORDER BY created_at")
      .bind(user.uid)
      .all<{ session_id: string; status: string }>();
    return json((results ?? []).map((r) => ({ id: r.session_id, status: r.status })));
  }

  const sel = path.match(/^\/api\/selections\/([^/]+)$/);
  if (sel) {
    const id = decodeURIComponent(sel[1]);
    if (req.method === "PUT") {
      let status = "favorite";
      const text = await req.text();
      if (text) {
        try {
          status = (JSON.parse(text) as { status?: string }).status ?? "favorite";
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
      }
      if (!SELECTION_STATUSES.has(status)) return json({ error: "status must be favorite or interested" }, 400);
      const exists = await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").bind(id).first();
      if (!exists) return json({ error: "unknown session" }, 404);
      await env.DB.prepare(UPSERT_SELECTION_SQL).bind(user.uid, id, status, new Date().toISOString()).run();
      return new Response(null, { status: 204 });
    }
    if (req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM selections WHERE user_id = ? AND session_id = ?").bind(user.uid, id).run();
      return new Response(null, { status: 204 });
    }
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);
    if (url.pathname === "/auth/login" && req.method === "GET") return login(req, env);
    if (url.pathname === "/auth/callback" && req.method === "GET") return callback(req, env);
    if (url.pathname === "/auth/logout" && (req.method === "GET" || req.method === "POST")) return logout();
    if (url.pathname.startsWith("/auth/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
