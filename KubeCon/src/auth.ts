import type { Env } from "./types";
export type Provider = "cloudflare" | "google";

export const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
// Spec R-5.2 asked for "openid ..." but the live authorize endpoint answers invalid_scope for
// openid with this client (verified 2026-11-09), so only the two API scopes are requested.
export const SCOPES = "user-details.read memberships.read";
const API = "https://api.cloudflare.com/client/v4";

export const SESSION_COOKIE = "kp_session";
export const OAUTH_COOKIE = "kp_oauth";
export const SESSION_TTL = 604800;
export const OAUTH_TTL = 600;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomB64url(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** `base64url(JSON)` + "." + `base64url(HMAC-SHA256(secret, payload))` (R-4.5). */
export async function signToken(obj: object, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(obj)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Verifies the HMAC (crypto.subtle.verify compares in constant time) and the `exp` claim. */
export async function verifyToken<T extends { exp: number }>(token: string | null, secret: string): Promise<T | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(token.slice(dot + 1)), enc.encode(payload));
    if (!ok) return null;
    const obj = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as T;
    if (typeof obj.exp !== "number" || obj.exp * 1000 < Date.now()) return null;
    return obj;
  } catch {
    return null;
  }
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function cookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;
}

export interface SessionUser {
  uid: string;
  email: string;
  exp: number;
  /** Sign-in provider; absent on cookies issued before Google sign-in existed (= cloudflare). */
  prov?: Provider;
}

export interface OAuthState {
  state: string;
  verifier: string;
  exp: number;
  prov?: Provider;
  /** Where to go after sign-in; only values in AFTER_LOGIN are used. */
  next?: string;
}

const AFTER_LOGIN = new Set(["/", "/admin"]);

/** Start an OAuth code + PKCE flow: returns the code challenge and the signed kp_oauth cookie value. */
export async function startOAuth(env: Env, prov: Provider, next = "/") {
  const state = randomB64url();
  const verifier = randomB64url();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  const oauth = await signToken({ state, verifier, prov, next: AFTER_LOGIN.has(next) ? next : "/", exp: Math.floor(Date.now() / 1000) + OAUTH_TTL }, env.SESSION_SECRET);
  return { state, challenge, cookie: cookie(OAUTH_COOKIE, oauth, OAUTH_TTL, "/auth") };
}

/** Verify kp_oauth and the returned state for the given provider. Returns the PKCE verifier or null. */
export async function checkOAuthState(req: Request, env: Env, prov: Provider): Promise<string | null> {
  const oauth = await verifyToken<OAuthState>(getCookie(req, OAUTH_COOKIE), env.SESSION_SECRET);
  const state = new URL(req.url).searchParams.get("state") ?? "";
  if (!oauth || !state || (oauth.prov ?? "cloudflare") !== prov || !timingSafeEqual(state, oauth.state)) return null;
  return oauth.verifier;
}

/** Where the in-progress sign-in should return to ("/" unless an allowed `next` was requested). */
export async function oauthNext(req: Request, env: Env): Promise<string> {
  const oauth = await verifyToken<OAuthState>(getCookie(req, OAUTH_COOKIE), env.SESSION_SECRET);
  return oauth?.next && AFTER_LOGIN.has(oauth.next) ? oauth.next : "/";
}

/** Successful sign-in: set kp_session, clear kp_oauth, redirect to `next` (default home). */
export async function signedIn(env: Env, uid: string, email: string, prov: Provider, next = "/"): Promise<Response> {
  const session = await signToken({ uid, email, prov, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, env.SESSION_SECRET);
  const headers = new Headers({ location: AFTER_LOGIN.has(next) ? next : "/", "cache-control": "no-store" });
  headers.append("set-cookie", cookie(SESSION_COOKIE, session, SESSION_TTL));
  headers.append("set-cookie", cookie(OAUTH_COOKIE, "", 0, "/auth"));
  return new Response(null, { status: 302, headers });
}

export async function currentUser(req: Request, env: Env): Promise<SessionUser | null> {
  return verifyToken<SessionUser>(getCookie(req, SESSION_COOKIE), env.SESSION_SECRET);
}

export function redirectUri(req: Request): string {
  return `${new URL(req.url).origin}/auth/callback`;
}

/** GET /auth/login (R-5.6). */
export async function login(req: Request, env: Env): Promise<Response> {
  const next = new URL(req.url).searchParams.get("next") ?? "/";
  const { state, challenge, cookie: oauthCookie } = await startOAuth(env, "cloudflare", next);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(req),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `${AUTHORIZE_URL}?${q.toString().replace(/\+/g, "%20")}`,
      "set-cookie": oauthCookie,
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function errorPage(status: number, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in problem</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="center"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p>
<p><a class="btn primary" href="/">Try again</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": cookie(OAUTH_COOKIE, "", 0, "/auth"),
      "cache-control": "no-store",
    },
  });
}

function decodeJwtSub(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(idToken.split(".")[1] ?? "")));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** R-5.9: allow-list email OR accepted membership of env.ACCOUNT_ID. */
export async function isAllowed(env: Env, email: string, accessToken: string, fetchImpl: typeof fetch): Promise<boolean> {
  const allowed = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (email && allowed.includes(email.toLowerCase())) return true;
  if (!env.ACCOUNT_ID) return false;
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`${API}/memberships?per_page=50&page=${page}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as any;
    const list: any[] = Array.isArray(body?.result) ? body.result : [];
    if (list.some((m) => m?.account?.id === env.ACCOUNT_ID && m?.status === "accepted")) return true;
    const totalPages = Number(body?.result_info?.total_pages ?? 0);
    if (list.length === 0 || (totalPages && page >= totalPages)) break;
  }
  return false;
}

/** GET /auth/callback (R-5.7). */
export async function callback(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) return errorPage(400, `Cloudflare returned: ${err}${url.searchParams.get("error_description") ? ` (${url.searchParams.get("error_description")})` : ""}`);

  const verifier = await checkOAuthState(req, env, "cloudflare");
  const code = url.searchParams.get("code") ?? "";
  if (!verifier) return errorPage(400, "The sign-in request expired or did not match. Please try again.");
  if (!code) return errorPage(400, "No authorization code was returned.");

  try {
    const tokenRes = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(req),
        client_id: env.OAUTH_CLIENT_ID,
        client_secret: env.OAUTH_CLIENT_SECRET,
        code_verifier: verifier,
      }).toString(),
      redirect: "manual",
    });
    if (!tokenRes.ok) return errorPage(502, `Token exchange failed (HTTP ${tokenRes.status}).`);
    const tok = (await tokenRes.json()) as any;
    const accessToken = tok?.access_token;
    if (typeof accessToken !== "string" || !accessToken) return errorPage(502, "Token exchange returned no access token.");

    const userRes = await fetchImpl(`${API}/user`, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
    const user = userRes.ok ? ((await userRes.json()) as any)?.result : null;
    const uid = (typeof user?.id === "string" && user.id) || decodeJwtSub(tok.id_token);
    const email = typeof user?.email === "string" ? user.email : "";
    if (!uid) return errorPage(502, "Could not read your Cloudflare user identity.");

    if (!(await isAllowed(env, email, accessToken, fetchImpl))) {
      return errorPage(403, "Not a member of this Cloudflare account");
    }

    return signedIn(env, uid, email, "cloudflare", await oauthNext(req, env));
  } catch {
    return errorPage(502, "Sign-in failed while talking to Cloudflare.");
  }
}

/** POST|GET /auth/logout (R-5.10). */
export function logout(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": cookie(SESSION_COOKIE, "", 0), "cache-control": "no-store" },
  });
}
