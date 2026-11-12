import { callback, currentUser, login, logout } from "./auth";
import { runImport } from "./importer";
import { adminPage } from "./admin";
import { createExportLink, exportDownload } from "./export";
import { touchUser } from "./usage";
import { googleCallback, googleLogin } from "./google";
import type { Env } from "./types";

export const SELECTION_STATUSES = new Set(["favorite", "interested"]);
export const UPSERT_SELECTION_SQL =
  "INSERT INTO selections (user_id, session_id, status, created_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(user_id, session_id) DO UPDATE SET status = excluded.status";

/** decodeURIComponent that returns null instead of throwing on malformed % sequences. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Copy a response and add the security headers (asset responses have immutable headers). */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

/** Error text safe to show users: our own import messages name the feed; anything else is generic. */
function publicError(e: unknown): string {
  const msg = (e as Error)?.message ?? "";
  console.error("request failed", msg);
  return /^(Feed "|Import produced)/.test(msg) ? msg : "Something went wrong. Please try again later.";
}

const MAX_BODY_BYTES = 1024;

/** Read a small request body, or null if it is larger than MAX_BODY_BYTES. */
async function readSmallBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

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
    "SELECT id, source, title, day, starts_at, ends_at, room, track, format, events, speaker_text, slides_url <> '' AS has_slides FROM sessions ORDER BY starts_at, id",
  ).all<Record<string, string | number | null>>();
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
    events: JSON.parse(String(r.events ?? "[]")),
    speakerText: r.speaker_text,
    hasSlides: Boolean(r.has_slides),
  }));
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== url.origin) {
    return json({ error: "forbidden" }, 403);
  }

  // Usage tracking for /admin. Never let it break the request.
  try {
    await touchUser(env.DB, user.uid, user.prov ?? "cloudflare");
  } catch (e) {
    console.error("touchUser failed", (e as Error).message);
  }

  const path = url.pathname;
  // Activity ping from the client (activity was recorded above). Who and when only.
  if (path === "/api/ping" && req.method === "POST") return new Response(null, { status: 204 });

  // Short-lived download link for this user's favorite and interested sessions (src/export.ts).
  if (path === "/api/export" && req.method === "POST") return json(await createExportLink(env, url.origin, user.uid));

  if (path === "/api/me" && req.method === "GET") {
    return json({ userId: user.uid, email: user.email, provider: user.prov ?? "cloudflare" });
  }

  if (path === "/api/sessions" && req.method === "GET") {
    let sessions = await listSessions(env);
    if (sessions.length === 0) {
      try {
        await runImport(env.DB);
      } catch (e) {
        return json({ error: publicError(e) }, 502);
      }
      sessions = await listSessions(env);
    }
    return json({ lastImportAt: await lastImportAt(env), sessions });
  }

  const one = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (one && req.method === "GET") {
    const sid = safeDecode(one[1]);
    if (sid === null) return json({ error: "not found" }, 404);
    const r = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sid).first<Record<string, string | null>>();
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
      slidesUrl: r.slides_url ?? "",
      recordingUrl: r.recording_url ?? "",
    });
  }

  if (path === "/api/import" && req.method === "POST") {
    try {
      const result = await runImport(env.DB);
      return json({ ...result, lastImportAt: await lastImportAt(env) });
    } catch (e) {
      return json({ error: publicError(e) }, 502);
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
    const id = safeDecode(sel[1]);
    if (id === null) return json({ error: "not found" }, 404);
    if (req.method === "PUT") {
      let status = "favorite";
      const text = await readSmallBody(req);
      if (text === null) return json({ error: "request body too large" }, 413);
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
    return withSecurityHeaders(await route(req, env));
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);
    if (url.pathname === "/admin" && req.method === "GET") return adminPage(req, env);
    const exp = url.pathname.match(/^\/export\/([A-Za-z0-9_.-]+)$/);
    if (exp && req.method === "GET") return exportDownload(exp[1], env);
    if (url.pathname.startsWith("/export/")) return new Response("Not found", { status: 404 });
    if (url.pathname === "/auth/login" && req.method === "GET") return login(req, env);
    if (url.pathname === "/auth/callback" && req.method === "GET") return callback(req, env);
    if (url.pathname === "/auth/google/login" && req.method === "GET") return googleLogin(req, env);
    if (url.pathname === "/auth/google/callback" && req.method === "GET") return googleCallback(req, env);
    if (url.pathname === "/auth/logout" && (req.method === "GET" || req.method === "POST")) return logout();
    if (url.pathname.startsWith("/auth/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(req);
  }
}
